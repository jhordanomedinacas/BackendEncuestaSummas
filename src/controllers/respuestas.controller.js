const { sql, getPool } = require("../config/db");
const { subirEvidencia } = require("../config/azureBlob");

/* POST /api/respuestas
   multipart/form-data:
     - campo "audio": archivo de audio de control (obligatorio si la
       encuesta tiene RequiereAudio = 1 — el hard constraint real ya se
       hizo en el navegador del asesor; aquí se vuelve a exigir en servidor)
     - campo "archivos": 0 a N archivos subidos en preguntas tipo "archivo"
     - campo "payload": JSON string con:
       {
         encuestaId, asignacionId, fechaHoraInicio,
         lat, lng, departamento, provincia, distrito,
         respuestas: [{ preguntaId, valorTexto?, opcionId?, opcionesIds?[], valorNumero?, valorFecha? }],
         archivoPreguntaIds: [preguntaId, ...]  // mismo orden que el campo "archivos"
       }
*/
async function registrar(req, res, next) {
  const pool = await getPool();

  try {
    const payload = JSON.parse(req.body.payload || "{}");
    const {
      encuestaId,
      asignacionId,
      fechaHoraInicio,
      lat,
      lng,
      departamento,
      provincia,
      distrito,
      respuestas = [],
      archivoPreguntaIds = [],
    } = payload;

    const audioFile = req.files?.audio?.[0];
    const archivosFiles = req.files?.archivos || [];

    if (!encuestaId || !asignacionId) {
      return res.status(400).json({ error: "encuestaId y asignacionId son obligatorios." });
    }

    // ---- Hard constraints (se re-validan en servidor, nunca solo en cliente) ----
    const encuestaResult = await pool
      .request()
      .input("EncuestaId", sql.VarChar(20), encuestaId)
      .query(`SELECT RequiereAudio, RequiereGeolocacion FROM Encuestas WHERE EncuestaId = @EncuestaId`);

    if (encuestaResult.recordset.length === 0) {
      return res.status(404).json({ error: "La encuesta no existe." });
    }
    const { RequiereAudio, RequiereGeolocacion } = encuestaResult.recordset[0];

    if (RequiereGeolocacion && (lat == null || lng == null)) {
      return res.status(422).json({ error: "Esta encuesta requiere geolocalización y no se recibieron coordenadas." });
    }
    if (RequiereAudio && !audioFile) {
      return res.status(422).json({ error: "Esta encuesta requiere grabación de audio y no se recibió el archivo." });
    }

    // ---- Validar que el asesor tiene esta asignación vigente ----
    await pool
      .request()
      .input("AsesorId", sql.Int, req.user.usuarioId)
      .input("EncuestaId", sql.VarChar(20), encuestaId)
      .execute("sp_ValidarAsignacionVigente"); // lanza RAISERROR si no aplica -> 400 en errorHandler

    // ---- Insertar la respuesta + finalizar asignación (transaccional, vía SP) ----
    const registroResult = await pool
      .request()
      .input("EncuestaId", sql.VarChar(20), encuestaId)
      .input("AsignacionId", sql.BigInt, asignacionId)
      .input("AsesorId", sql.Int, req.user.usuarioId)
      .input("CorreoAsesor", sql.NVarChar(150), req.user.correo)
      .input("FechaHoraInicio", sql.DateTime2, new Date(fechaHoraInicio || Date.now()))
      .input("UbicacionLat", sql.Decimal(9, 6), lat ?? null)
      .input("UbicacionLng", sql.Decimal(9, 6), lng ?? null)
      .input("Departamento", sql.NVarChar(100), departamento || null)
      .input("Provincia", sql.NVarChar(100), provincia || null)
      .input("Distrito", sql.NVarChar(100), distrito || null)
      .input("NombreEncuestado", sql.NVarChar(200), payload.nombreEncuestado || null)
      .input("DNIEncuestado", sql.NVarChar(20), payload.dniEncuestado || null)
      .input("Dispositivo", sql.NVarChar(200), req.headers["user-agent"] || null)
      .execute("sp_RegistrarRespuestaEncuesta");

    const respuestaEncuestaId = registroResult.recordset[0].RespuestaEncuestaId;

    // ---- Guardar el detalle de cada pregunta respondida ----
    for (const r of respuestas) {
      const detalleResult = await pool
        .request()
        .input("RespuestaEncuestaId", sql.VarChar(20), respuestaEncuestaId)
        .input("PreguntaId", sql.Int, r.preguntaId)
        .input("ValorTexto", sql.NVarChar(sql.MAX), r.valorTexto ?? null)
        .input("OpcionSeleccionadaId", sql.Int, r.opcionId ?? null)
        .input("ValorNumero", sql.Decimal(9, 2), r.valorNumero ?? null)
        .input("ValorFecha", sql.Date, r.valorFecha ?? null)
        .query(`
          INSERT INTO DetalleRespuestas
            (RespuestaEncuestaId, PreguntaId, ValorTexto, OpcionSeleccionadaId, ValorNumero, ValorFecha)
          OUTPUT INSERTED.DetalleId
          VALUES (@RespuestaEncuestaId, @PreguntaId, @ValorTexto, @OpcionSeleccionadaId, @ValorNumero, @ValorFecha)
        `);

      const detalleId = detalleResult.recordset[0].DetalleId;

      // casillas de verificación: varias opciones para la misma pregunta
      if (Array.isArray(r.opcionesIds)) {
        for (const opcionId of r.opcionesIds) {
          await pool
            .request()
            .input("DetalleId", sql.BigInt, detalleId)
            .input("OpcionId", sql.Int, opcionId)
            .query(`INSERT INTO DetalleRespuestasCasillas (DetalleId, OpcionId) VALUES (@DetalleId, @OpcionId)`);
        }
      }
    }

    // ---- Subir el audio de control, etiquetado con el ID de la respuesta ----
    if (audioFile) {
      const { blobPath } = await subirEvidencia(respuestaEncuestaId, audioFile.buffer, audioFile.originalname, audioFile.mimetype, req);

      await pool
        .request()
        .input("RespuestaEncuestaId", sql.VarChar(20), respuestaEncuestaId)
        .input("TipoArchivo", sql.NVarChar(20), "AudioControl")
        .input("RutaBlobAzure", sql.NVarChar(500), blobPath)
        .input("NombreOriginal", sql.NVarChar(260), audioFile.originalname)
        .input("TamanioBytes", sql.BigInt, audioFile.size)
        .query(`
          INSERT INTO Evidencias (RespuestaEncuestaId, TipoArchivo, RutaBlobAzure, NombreOriginal, TamanioBytes)
          VALUES (@RespuestaEncuestaId, @TipoArchivo, @RutaBlobAzure, @NombreOriginal, @TamanioBytes)
        `);
    }

    // ---- Subir los adjuntos (fotos/archivos de preguntas tipo "archivo") ----
    for (let i = 0; i < archivosFiles.length; i++) {
      const archivo = archivosFiles[i];
      const preguntaId = archivoPreguntaIds[i] ?? null;

      const { blobPath } = await subirEvidencia(respuestaEncuestaId, archivo.buffer, archivo.originalname, archivo.mimetype, req);

      await pool
        .request()
        .input("RespuestaEncuestaId", sql.VarChar(20), respuestaEncuestaId)
        .input("PreguntaId", sql.Int, preguntaId)
        .input("TipoArchivo", sql.NVarChar(20), "Adjunto")
        .input("RutaBlobAzure", sql.NVarChar(500), blobPath)
        .input("NombreOriginal", sql.NVarChar(260), archivo.originalname)
        .input("TamanioBytes", sql.BigInt, archivo.size)
        .query(`
          INSERT INTO Evidencias (RespuestaEncuestaId, PreguntaId, TipoArchivo, RutaBlobAzure, NombreOriginal, TamanioBytes)
          VALUES (@RespuestaEncuestaId, @PreguntaId, @TipoArchivo, @RutaBlobAzure, @NombreOriginal, @TamanioBytes)
        `);
    }

    res.status(201).json({ respuestaEncuestaId });
  } catch (err) {
    next(err);
  }
}

module.exports = { registrar };
