const { sql, getPool } = require("../config/db");
const { registrarActividad } = require("../utils/auditoria");

/* GET /api/encuestas */
async function listar(req, res, next) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        e.EncuestaId, e.Titulo, e.Descripcion, e.Estado,
        e.RequiereAudio, e.RequiereGeolocacion, e.FechaCreacion,
        (SELECT COUNT(*) FROM Preguntas p WHERE p.EncuestaId = e.EncuestaId) AS TotalPreguntas,
        (SELECT COUNT(*) FROM RespuestasEncuesta r WHERE r.EncuestaId = e.EncuestaId) AS TotalRespuestas
      FROM Encuestas e
      ORDER BY e.FechaCreacion DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

/* GET /api/encuestas/:id  — detalle completo (usa sp_ValidarEncuestaPorId) */
async function detalle(req, res, next) {
  try {
    const { id } = req.params;
    const pool = await getPool();

    // sp_ValidarEncuestaPorId lanza RAISERROR (-> 400 vía errorHandler) si no existe o no está activa;
    // aquí solo queremos "existe o no", así que consultamos directo para permitir ver Borradores también.
    const encuestaResult = await pool
      .request()
      .input("EncuestaId", sql.VarChar(20), id)
      .query(`SELECT * FROM Encuestas WHERE EncuestaId = @EncuestaId`);

    if (encuestaResult.recordset.length === 0) {
      return res.status(404).json({ error: "Encuesta no encontrada." });
    }
    const encuesta = encuestaResult.recordset[0];

    const preguntasResult = await pool
      .request()
      .input("EncuestaId", sql.VarChar(20), id)
      .query(`SELECT * FROM Preguntas WHERE EncuestaId = @EncuestaId ORDER BY Orden`);

    const preguntaIds = preguntasResult.recordset.map((p) => p.PreguntaId);
    let opciones = [];
    let saltos = [];

    if (preguntaIds.length > 0) {
      const idsCsv = preguntaIds.join(",");
      const opcionesResult = await pool.request().query(
        `SELECT * FROM PreguntaOpciones WHERE PreguntaId IN (${idsCsv}) ORDER BY Orden`
      );
      opciones = opcionesResult.recordset;

      const saltosResult = await pool.request().query(
        `SELECT * FROM PreguntaSaltos WHERE PreguntaOrigenId IN (${idsCsv})`
      );
      saltos = saltosResult.recordset;
    }

    const preguntas = preguntasResult.recordset.map((p) => ({
      ...p,
      opciones: opciones.filter((o) => o.PreguntaId === p.PreguntaId),
      saltos: saltos.filter((s) => s.PreguntaOrigenId === p.PreguntaId),
    }));

    res.json({ ...encuesta, preguntas });
  } catch (err) {
    next(err);
  }
}

/* POST /api/encuestas  { titulo, descripcion, requiereAudio, requiereGeolocacion } */
async function crear(req, res, next) {
  try {
    const { titulo, descripcion, requiereAudio = true, requiereGeolocacion = true, campaniaId = null } = req.body;
    if (!titulo || !titulo.trim()) {
      return res.status(400).json({ error: "El título es obligatorio." });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("Titulo", sql.NVarChar(200), titulo)
      .input("Descripcion", sql.NVarChar(500), descripcion || null)
      .input("CampaniaId", sql.Int, campaniaId)
      .input("RequiereAudio", sql.Bit, requiereAudio)
      .input("RequiereGeolocacion", sql.Bit, requiereGeolocacion)
      .input("CreadoPor", sql.Int, req.user.usuarioId)
      .query(`
        INSERT INTO Encuestas (Titulo, Descripcion, CampaniaId, RequiereAudio, RequiereGeolocacion, CreadoPor)
        OUTPUT INSERTED.EncuestaId
        VALUES (@Titulo, @Descripcion, @CampaniaId, @RequiereAudio, @RequiereGeolocacion, @CreadoPor)
      `);

    res.status(201).json({ encuestaId: result.recordset[0].EncuestaId });

    registrarActividad(pool, {
      usuarioId: req.user.usuarioId,
      accion: "CREAR_ENCUESTA",
      entidad: "Encuestas",
      entidadId: result.recordset[0].EncuestaId,
      detalle: `Creó la encuesta "${titulo}"`,
      req,
    });
  } catch (err) {
    next(err);
  }
}

/* PUT /api/encuestas/:id
   Guarda título/descripción/config y REEMPLAZA todas las preguntas
   (así es como el constructor del frontend arma el estado: todo o nada,
   dentro de una transacción). */
async function guardar(req, res, next) {
  const { id } = req.params;
  const { titulo, descripcion, requiereAudio, requiereGeolocacion, campaniaId, preguntas = [] } = req.body;

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  try {
    await transaction.begin();

    await new sql.Request(transaction)
      .input("EncuestaId", sql.VarChar(20), id)
      .input("Titulo", sql.NVarChar(200), titulo)
      .input("Descripcion", sql.NVarChar(500), descripcion || null)
      .input("RequiereAudio", sql.Bit, requiereAudio)
      .input("RequiereGeolocacion", sql.Bit, requiereGeolocacion)
      .input("CampaniaId", sql.Int, campaniaId || null)
      .query(`
        UPDATE Encuestas
        SET Titulo = @Titulo, Descripcion = @Descripcion,
            RequiereAudio = @RequiereAudio, RequiereGeolocacion = @RequiereGeolocacion,
            CampaniaId = @CampaniaId,
            FechaActualizacion = SYSUTCDATETIME()
        WHERE EncuestaId = @EncuestaId
      `);

    // Reemplazo total de preguntas/opciones/saltos existentes
    const existentes = await new sql.Request(transaction)
      .input("EncuestaId", sql.VarChar(20), id)
      .query(`SELECT PreguntaId FROM Preguntas WHERE EncuestaId = @EncuestaId`);
    const idsExistentes = existentes.recordset.map((r) => r.PreguntaId);

    if (idsExistentes.length > 0) {
      const idsCsv = idsExistentes.join(",");
      await new sql.Request(transaction).query(`DELETE FROM PreguntaSaltos WHERE PreguntaOrigenId IN (${idsCsv})`);
      await new sql.Request(transaction).query(`DELETE FROM PreguntaOpciones WHERE PreguntaId IN (${idsCsv})`);
      await new sql.Request(transaction).query(`DELETE FROM Preguntas WHERE PreguntaId IN (${idsCsv})`);
    }

    // mapas para resolver los saltos condicionales tras insertar todo
    const preguntaIdPorOrden = new Map();     // ordenFrontend -> PreguntaId (SQL)
    const opcionIdPorPreguntaTexto = new Map(); // `${orden}::${texto}` -> OpcionId (SQL)

    for (let i = 0; i < preguntas.length; i++) {
      const p = preguntas[i];
      const configuracionJSON = JSON.stringify({
        maxChars: p.maxChars ?? null,
        ratingStyle: p.ratingStyle ?? null,
        ratingMax: p.ratingMax ?? null,
        maxFileSizeMB: p.maxFileSizeMB ?? null,
        allowedExtensions: p.allowedExtensions ?? null,
      });

      const insertPregunta = await new sql.Request(transaction)
        .input("EncuestaId", sql.VarChar(20), id)
        .input("Orden", sql.Int, i + 1)
        .input("Tipo", sql.NVarChar(30), p.type)
        .input("TituloPregunta", sql.NVarChar(400), p.title || "")
        .input("Obligatoria", sql.Bit, !!p.required)
        .input("Aleatorizar", sql.Bit, !!p.randomize)
        .input("ConfiguracionJSON", sql.NVarChar(sql.MAX), configuracionJSON)
        .query(`
          INSERT INTO Preguntas (EncuestaId, Orden, Tipo, TituloPregunta, Obligatoria, Aleatorizar, ConfiguracionJSON)
          OUTPUT INSERTED.PreguntaId
          VALUES (@EncuestaId, @Orden, @Tipo, @TituloPregunta, @Obligatoria, @Aleatorizar, @ConfiguracionJSON)
        `);

      const preguntaId = insertPregunta.recordset[0].PreguntaId;
      preguntaIdPorOrden.set(i + 1, preguntaId);

      const opciones = Array.isArray(p.options) ? p.options : [];
      for (let j = 0; j < opciones.length; j++) {
        const insertOpcion = await new sql.Request(transaction)
          .input("PreguntaId", sql.Int, preguntaId)
          .input("Texto", sql.NVarChar(300), opciones[j])
          .input("Orden", sql.Int, j + 1)
          .query(`
            INSERT INTO PreguntaOpciones (PreguntaId, Texto, Orden)
            OUTPUT INSERTED.OpcionId
            VALUES (@PreguntaId, @Texto, @Orden)
          `);
        opcionIdPorPreguntaTexto.set(`${i + 1}::${opciones[j]}`, insertOpcion.recordset[0].OpcionId);
      }
    }

    // Segunda pasada: saltos condicionales (ya existen todos los PreguntaId/OpcionId)
    for (let i = 0; i < preguntas.length; i++) {
      const p = preguntas[i];
      if (!p.skipLogic || !p.skipLogic.fromOption) continue;

      const opcionId = opcionIdPorPreguntaTexto.get(`${i + 1}::${p.skipLogic.fromOption}`);
      if (!opcionId) continue;

      const preguntaOrigenId = preguntaIdPorOrden.get(i + 1);
      const targetOrdenExiste = p.skipLogic.target
        ? preguntas.findIndex((pp) => pp.id === p.skipLogic.target) + 1
        : null;
      const preguntaDestinoId = targetOrdenExiste ? preguntaIdPorOrden.get(targetOrdenExiste) : null;

      await new sql.Request(transaction)
        .input("PreguntaOrigenId", sql.Int, preguntaOrigenId)
        .input("OpcionDisparadoraId", sql.Int, opcionId)
        .input("PreguntaDestinoId", sql.Int, preguntaDestinoId)
        .input("AccionEspecial", sql.NVarChar(20), preguntaDestinoId ? null : "FinalizarEncuesta")
        .query(`
          INSERT INTO PreguntaSaltos (PreguntaOrigenId, OpcionDisparadoraId, PreguntaDestinoId, AccionEspecial)
          VALUES (@PreguntaOrigenId, @OpcionDisparadoraId, @PreguntaDestinoId, @AccionEspecial)
        `);
    }

    await transaction.commit();
    res.json({ ok: true });

    registrarActividad(pool, {
      usuarioId: req.user.usuarioId,
      accion: "EDITAR_ENCUESTA",
      entidad: "Encuestas",
      entidadId: id,
      detalle: `Editó la encuesta "${titulo}" (${preguntas.length} pregunta(s))`,
      req,
    });
  } catch (err) {
    await transaction.rollback();
    next(err);
  }
}

/* PUT /api/encuestas/:id/publicar */
async function publicar(req, res, next) {
  try {
    const { id } = req.params;
    const pool = await getPool();

    const preguntas = await pool
      .request()
      .input("EncuestaId", sql.VarChar(20), id)
      .query(`SELECT COUNT(*) AS Total FROM Preguntas WHERE EncuestaId = @EncuestaId`);

    if (preguntas.recordset[0].Total === 0) {
      return res.status(400).json({ error: "No puedes publicar una encuesta sin preguntas." });
    }

    await pool
      .request()
      .input("EncuestaId", sql.VarChar(20), id)
      .query(`UPDATE Encuestas SET Estado = 'Activa' WHERE EncuestaId = @EncuestaId`);

    const tituloResult = await pool
      .request()
      .input("EncuestaId", sql.VarChar(20), id)
      .query(`SELECT Titulo FROM Encuestas WHERE EncuestaId = @EncuestaId`);
    const tituloEncuesta = tituloResult.recordset[0]?.Titulo || id;

    res.json({ ok: true });

    registrarActividad(pool, {
      usuarioId: req.user.usuarioId,
      accion: "PUBLICAR_ENCUESTA",
      entidad: "Encuestas",
      entidadId: id,
      detalle: `Publicó la encuesta "${tituloEncuesta}" (pasó a estar Activa)`,
      req,
    });
  } catch (err) {
    next(err);
  }
}

/* DELETE /api/encuestas/:id
   Borrado real si la encuesta no tiene asignaciones ni respuestas
   (para no romper la trazabilidad). Si ya tiene actividad, se bloquea
   y se sugiere archivar (Cerrada) en su lugar. */
async function eliminar(req, res, next) {
  try {
    const { id } = req.params;
    const pool = await getPool();

    const tituloResult = await pool
      .request()
      .input("EncuestaId", sql.VarChar(20), id)
      .query(`SELECT Titulo FROM Encuestas WHERE EncuestaId = @EncuestaId`);
    const tituloEncuesta = tituloResult.recordset[0]?.Titulo || id;

    const bloqueos = await pool
      .request()
      .input("EncuestaId", sql.VarChar(20), id)
      .query(`
        SELECT
          (SELECT COUNT(*) FROM Asignaciones WHERE EncuestaId = @EncuestaId) AS asignaciones,
          (SELECT COUNT(*) FROM RespuestasEncuesta WHERE EncuestaId = @EncuestaId) AS respuestas
      `);

    const { asignaciones, respuestas } = bloqueos.recordset[0];

    if (asignaciones > 0 || respuestas > 0) {
      // ya tiene actividad real: no se borra, se archiva para no perder el historial
      await pool
        .request()
        .input("EncuestaId", sql.VarChar(20), id)
        .query(`UPDATE Encuestas SET Estado = 'Cerrada' WHERE EncuestaId = @EncuestaId`);

      registrarActividad(pool, {
        usuarioId: req.user.usuarioId,
        accion: "ARCHIVAR_ENCUESTA",
        entidad: "Encuestas",
        entidadId: id,
        detalle: `Intentó eliminar la encuesta "${tituloEncuesta}", pero como ya tenía actividad se archivó (Cerrada) en su lugar`,
        req,
      });

      return res.json({ ok: true, archivada: true, mensaje: "Esta encuesta ya tiene asignaciones o respuestas, así que se archivó (Cerrada) en vez de borrarse, para no perder el historial." });
    }

    // sin actividad: borrado real, en cascada manual
    const preguntas = await pool
      .request()
      .input("EncuestaId", sql.VarChar(20), id)
      .query(`SELECT PreguntaId FROM Preguntas WHERE EncuestaId = @EncuestaId`);
    const preguntaIds = preguntas.recordset.map((p) => p.PreguntaId);

    if (preguntaIds.length > 0) {
      const idsCsv = preguntaIds.join(",");
      await pool.request().query(`DELETE FROM PreguntaSaltos WHERE PreguntaOrigenId IN (${idsCsv})`);
      await pool.request().query(`DELETE FROM PreguntaOpciones WHERE PreguntaId IN (${idsCsv})`);
      await pool.request().query(`DELETE FROM Preguntas WHERE PreguntaId IN (${idsCsv})`);
    }

    await pool.request().input("EncuestaId", sql.VarChar(20), id).query(`DELETE FROM Encuestas WHERE EncuestaId = @EncuestaId`);

    res.json({ ok: true, archivada: false });

    registrarActividad(pool, {
      usuarioId: req.user.usuarioId,
      accion: "ELIMINAR_ENCUESTA",
      entidad: "Encuestas",
      entidadId: id,
      detalle: `Eliminó por completo la encuesta "${tituloEncuesta}"`,
      req,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listar, detalle, crear, guardar, publicar, eliminar };
