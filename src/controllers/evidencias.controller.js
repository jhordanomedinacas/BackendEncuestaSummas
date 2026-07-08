const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { sql, getPool } = require("../config/db");
const { obtenerUrlEvidencia, azureConfigurado } = require("../config/azureBlob");
const { UPLOADS_DIR } = require("../config/localStorage");
const { registrarActividad } = require("../utils/auditoria");

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
        r.Estado, r.EstadoAuditoria, r.UbicacionLat, r.UbicacionLng, r.Departamento, r.Provincia, r.Distrito,
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
        url: await obtenerUrlEvidencia(ev.RutaBlobAzure, req),
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
    await pool.request().input("RespuestaEncuestaId", sql.VarChar(20), respuestaId).query(`DELETE FROM RespuestasEncuesta WHERE RespuestaEncuestaId = @RespuestaEncuestaId`);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

module.exports = { listar, detalle, eliminarRespuesta, actualizarEstadoAuditoria, exportarExcel };

/* PUT /api/evidencias/:respuestaId/estado-auditoria  { estado }
   El Supervisor/Admin califica cada entrevista tras revisarla. */
async function actualizarEstadoAuditoria(req, res, next) {
  try {
    const { respuestaId } = req.params;
    const { estado } = req.body;
    const ESTADOS_VALIDOS = ["Efectiva", "No efectiva", "Fuera de cuota", "No verificada"];

    if (!ESTADOS_VALIDOS.includes(estado)) {
      return res.status(400).json({ error: `Estado inválido. Usa uno de: ${ESTADOS_VALIDOS.join(", ")}` });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("RespuestaEncuestaId", sql.VarChar(20), respuestaId)
      .input("EstadoAuditoria", sql.NVarChar(30), estado)
      .query(`
        UPDATE RespuestasEncuesta SET EstadoAuditoria = @EstadoAuditoria
        WHERE RespuestaEncuestaId = @RespuestaEncuestaId
      `);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ error: "La respuesta no existe." });
    }

    res.json({ ok: true });

    registrarActividad(pool, {
      usuarioId: req.user.usuarioId,
      accion: "CALIFICAR_ENTREVISTA",
      entidad: "RespuestasEncuesta",
      entidadId: respuestaId,
      detalle: `Calificó la entrevista ${respuestaId} como "${estado}"`,
      req,
    });
  } catch (err) {
    next(err);
  }
}

/* GET /api/evidencias/exportar?encuestaId=...
   Descarga en Excel (.xlsx) toda la información de Encuestados,
   ordenada, con una fila por entrevista — pensado para que el
   Supervisor no tenga que reprocesar nada manualmente. */
async function exportarExcel(req, res, next) {
  try {
    const { encuestaId } = req.query;
    const pool = await getPool();
    const request = pool.request();

    let where = "";
    if (encuestaId) {
      request.input("EncuestaId", sql.VarChar(20), encuestaId);
      where = "WHERE r.EncuestaId = @EncuestaId";
    }

    const respuestasResult = await request.query(`
      SELECT
        r.RespuestaEncuestaId, r.EncuestaId, e.Titulo AS TituloEncuesta,
        r.NombreEncuestado, r.DNIEncuestado, r.CorreoAsesor,
        r.FechaHoraInicio, r.FechaHoraFin, r.Estado, r.EstadoAuditoria,
        r.Departamento, r.Provincia, r.Distrito, r.UbicacionLat, r.UbicacionLng,
        (SELECT COUNT(*) FROM Evidencias ev WHERE ev.RespuestaEncuestaId = r.RespuestaEncuestaId AND ev.TipoArchivo = 'AudioControl') AS TieneAudio
      FROM RespuestasEncuesta r
      JOIN Encuestas e ON e.EncuestaId = r.EncuestaId
      ${where}
      ORDER BY r.FechaHoraFin DESC
    `);

    const respuestas = respuestasResult.recordset;
    const idsCsv = respuestas.map((r) => `'${r.RespuestaEncuestaId}'`).join(",") || "''";

    const detallesResult = await pool.request().query(`
      SELECT d.RespuestaEncuestaId, p.Orden, p.TituloPregunta, d.ValorTexto, d.ValorNumero, d.ValorFecha, d.OpcionSeleccionadaId,
             op.Texto AS TextoOpcion
      FROM DetalleRespuestas d
      JOIN Preguntas p ON p.PreguntaId = d.PreguntaId
      LEFT JOIN PreguntaOpciones op ON op.OpcionId = d.OpcionSeleccionadaId
      WHERE d.RespuestaEncuestaId IN (${idsCsv})
      ORDER BY d.RespuestaEncuestaId, p.Orden
    `);

    // arma un texto "Pregunta: respuesta | Pregunta: respuesta" por entrevista
    const respuestasPorId = {};
    detallesResult.recordset.forEach((d) => {
      const valor = d.TextoOpcion ?? d.ValorTexto ?? d.ValorNumero ?? d.ValorFecha ?? "—";
      const linea = `${d.TituloPregunta}: ${valor}`;
      respuestasPorId[d.RespuestaEncuestaId] = respuestasPorId[d.RespuestaEncuestaId]
        ? `${respuestasPorId[d.RespuestaEncuestaId]} | ${linea}`
        : linea;
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Panel de Encuestas";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Encuestados", { views: [{ state: "frozen", ySplit: 1 }] });

    sheet.columns = [
      { header: "ID Encuesta", key: "idEncuesta", width: 14 },
      { header: "Encuesta", key: "tituloEncuesta", width: 28 },
      { header: "Encuestado", key: "encuestado", width: 22 },
      { header: "DNI", key: "dni", width: 14 },
      { header: "Asesor", key: "asesor", width: 26 },
      { header: "Fecha inicio", key: "fechaInicio", width: 20 },
      { header: "Fecha fin", key: "fechaFin", width: 20 },
      { header: "Departamento", key: "departamento", width: 16 },
      { header: "Provincia", key: "provincia", width: 16 },
      { header: "Distrito", key: "distrito", width: 16 },
      { header: "Coordenadas", key: "coordenadas", width: 20 },
      { header: "Audio", key: "audio", width: 10 },
      { header: "Estado", key: "estado", width: 14 },
      { header: "Estado de auditoría", key: "estadoAuditoria", width: 18 },
      { header: "Respuestas", key: "respuestas", width: 80 },
    ];

    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D2C4F" } };
    sheet.getRow(1).alignment = { vertical: "middle" };

    respuestas.forEach((r) => {
      sheet.addRow({
        idEncuesta: r.EncuestaId,
        tituloEncuesta: r.TituloEncuesta,
        encuestado: r.NombreEncuestado || "—",
        dni: r.DNIEncuestado || "—",
        asesor: r.CorreoAsesor,
        fechaInicio: r.FechaHoraInicio ? new Date(r.FechaHoraInicio) : null,
        fechaFin: r.FechaHoraFin ? new Date(r.FechaHoraFin) : null,
        departamento: r.Departamento || "—",
        provincia: r.Provincia || "—",
        distrito: r.Distrito || "—",
        coordenadas: r.UbicacionLat != null ? `${r.UbicacionLat}, ${r.UbicacionLng}` : "—",
        audio: r.TieneAudio > 0 ? "Sí" : "No",
        estado: r.Estado,
        estadoAuditoria: r.EstadoAuditoria || "Sin calificar",
        respuestas: respuestasPorId[r.RespuestaEncuestaId] || "",
      });
    });

    sheet.getColumn("fechaInicio").numFmt = "dd/mm/yyyy hh:mm";
    sheet.getColumn("fechaFin").numFmt = "dd/mm/yyyy hh:mm";
    sheet.autoFilter = { from: "A1", to: "O1" };

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="encuestados_${Date.now()}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
}
