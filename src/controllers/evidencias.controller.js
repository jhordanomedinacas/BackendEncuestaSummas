const fs = require("fs");
const path = require("path");
const { sql, getPool } = require("../config/db");
const { obtenerUrlEvidencia, azureConfigurado } = require("../config/azureBlob");
const { UPLOADS_DIR } = require("../config/localStorage");

/* GET /api/evidencias?encuestaId=... — repositorio con filtro por encuesta */
async function listar(req, res, next) {
  try {
    const { encuestaId } = req.query;
    const pool = await getPool();
    const request = pool.request();

    let where = "";
    if (encuestaId) {
      request.input("EncuestaId", sql.VarChar(20), encuestaId);
      where = "WHERE r.EncuestaId = @EncuestaId";
    }

    const result = await request.query(`
      SELECT
        r.RespuestaEncuestaId, r.EncuestaId, r.CorreoAsesor, r.NombreEncuestado, r.DNIEncuestado, r.FechaHoraFin,
        r.Estado, r.UbicacionLat, r.UbicacionLng, r.Departamento, r.Provincia, r.Distrito,
        (SELECT TOP 1 RutaBlobAzure FROM Evidencias WHERE RespuestaEncuestaId = r.RespuestaEncuestaId AND TipoArchivo = 'AudioControl') AS AudioRutaBlobAzure,
        (SELECT COUNT(*) FROM Evidencias WHERE RespuestaEncuestaId = r.RespuestaEncuestaId AND TipoArchivo = 'AudioControl') AS TieneAudio,
        (SELECT COUNT(*) FROM Evidencias WHERE RespuestaEncuestaId = r.RespuestaEncuestaId AND TipoArchivo = 'Adjunto') AS TotalAdjuntos
      FROM RespuestasEncuesta r
      ${where}
      ORDER BY r.FechaHoraFin DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

/* GET /api/evidencias/:respuestaId — detalle completo por ID (trazabilidad) */
async function detalle(req, res, next) {
  try {
    const { respuestaId } = req.params;
    const pool = await getPool();

    const respuesta = await pool
      .request()
      .input("RespuestaEncuestaId", sql.VarChar(20), respuestaId)
      .query(`SELECT * FROM RespuestasEncuesta WHERE RespuestaEncuestaId = @RespuestaEncuestaId`);

    if (respuesta.recordset.length === 0) {
      return res.status(404).json({ error: "Respuesta no encontrada." });
    }

    const detalles = await pool
      .request()
      .input("RespuestaEncuestaId", sql.VarChar(20), respuestaId)
      .query(`
        SELECT d.*, p.TituloPregunta, p.Tipo
        FROM DetalleRespuestas d
        JOIN Preguntas p ON p.PreguntaId = d.PreguntaId
        WHERE d.RespuestaEncuestaId = @RespuestaEncuestaId
      `);

    const evidencias = await pool
      .request()
      .input("RespuestaEncuestaId", sql.VarChar(20), respuestaId)
      .query(`SELECT * FROM Evidencias WHERE RespuestaEncuestaId = @RespuestaEncuestaId`);

    // adjunta la URL de streaming/descarga a cada evidencia
    const evidenciasConUrl = await Promise.all(
      evidencias.recordset.map(async (ev) => ({
        ...ev,
        url: await obtenerUrlEvidencia(ev.RutaBlobAzure),
      }))
    );

    res.json({
      ...respuesta.recordset[0],
      detalles: detalles.recordset,
      evidencias: evidenciasConUrl,
    });
  } catch (err) {
    next(err);
  }
}

/* DELETE /api/evidencias/:respuestaId
   Borra por completo una respuesta (detalle, evidencias, telemetría y
   el registro mismo). Útil para limpiar registros que no cumplen
   requisitos (ej. sin el audio obligatorio). La Asignación queda tal
   cual (el hecho de que se finalizó ya ocurrió); si quieren que la
   vuelvan a responder, hay que crear una asignación nueva.
   No revierte el estado de Asignaciones a propósito: eso respeta la
   máquina de estados sin pelear contra el trigger. */
async function eliminarRespuesta(req, res, next) {
  try {
    const { respuestaId } = req.params;
    const pool = await getPool();

    const existe = await pool
      .request()
      .input("RespuestaEncuestaId", sql.VarChar(20), respuestaId)
      .query(`SELECT RespuestaEncuestaId FROM RespuestasEncuesta WHERE RespuestaEncuestaId = @RespuestaEncuestaId`);

    if (existe.recordset.length === 0) {
      return res.status(404).json({ error: "La respuesta no existe." });
    }

    // borra el archivo físico local si aplica (si es Azure, se deja el blob por ahora)
    if (!azureConfigurado()) {
      const evidencias = await pool
        .request()
        .input("RespuestaEncuestaId", sql.VarChar(20), respuestaId)
        .query(`SELECT RutaBlobAzure FROM Evidencias WHERE RespuestaEncuestaId = @RespuestaEncuestaId`);

      for (const ev of evidencias.recordset) {
        const rutaLocal = path.join(UPLOADS_DIR, ev.RutaBlobAzure);
        fs.unlink(rutaLocal, () => {}); // best-effort, no bloquea si falla
      }
    }

    await pool.request().input("RespuestaEncuestaId", sql.VarChar(20), respuestaId).query(`
      DELETE FROM DetalleRespuestasCasillas
      WHERE DetalleId IN (SELECT DetalleId FROM DetalleRespuestas WHERE RespuestaEncuestaId = @RespuestaEncuestaId)
    `);
    await pool.request().input("RespuestaEncuestaId", sql.VarChar(20), respuestaId).query(`DELETE FROM DetalleRespuestas WHERE RespuestaEncuestaId = @RespuestaEncuestaId`);
    await pool.request().input("RespuestaEncuestaId", sql.VarChar(20), respuestaId).query(`DELETE FROM Evidencias WHERE RespuestaEncuestaId = @RespuestaEncuestaId`);
    await pool.request().input("RespuestaEncuestaId", sql.VarChar(20), respuestaId).query(`DELETE FROM TelemetriaGPS WHERE RespuestaEncuestaId = @RespuestaEncuestaId`);
    await pool.request().input("RespuestaEncuestaId", sql.VarChar(20), respuestaId).query(`DELETE FROM RespuestasEncuesta WHERE RespuestaEncuestaId = @RespuestaEncuestaId`);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { listar, detalle, eliminarRespuesta };
