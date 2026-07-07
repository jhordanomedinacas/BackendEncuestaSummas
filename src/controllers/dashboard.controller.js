const { sql, getPool } = require("../config/db");

/* GET /api/dashboard/resumen */
async function resumen(req, res, next) {
  try {
    const pool = await getPool();

    const [encuestasActivas, encuestados, usuariosActivos, audios, asignaciones] = await Promise.all([
      pool.request().query(`SELECT COUNT(*) AS total FROM Encuestas WHERE Estado = 'Activa'`),
      pool.request().query(`SELECT COUNT(*) AS total FROM RespuestasEncuesta`),
      pool.request().query(`SELECT COUNT(*) AS total FROM Usuarios WHERE Estado = 'Activo'`),
      pool.request().query(`SELECT COUNT(*) AS total FROM Evidencias WHERE TipoArchivo = 'AudioControl'`),
      pool.request().query(`
        SELECT
          COUNT(DISTINCT CASE WHEN r.AsignacionId IS NOT NULL THEN a.AsignacionId END) AS completadas,
          COUNT(DISTINCT CASE WHEN r.AsignacionId IS NULL THEN a.AsignacionId END) AS pendientes
        FROM Asignaciones a
        LEFT JOIN RespuestasEncuesta r ON r.AsignacionId = a.AsignacionId
      `),
    ]);

    res.json({
      encuestasActivas: encuestasActivas.recordset[0].total,
      encuestadosTotales: encuestados.recordset[0].total,
      usuariosActivos: usuariosActivos.recordset[0].total,
      audiosRecibidos: audios.recordset[0].total,
      asignacionesCompletadas: asignaciones.recordset[0].completadas || 0,
      asignacionesPendientes: asignaciones.recordset[0].pendientes || 0,
    });
  } catch (err) {
    next(err);
  }
}

/* GET /api/dashboard/avance-campanias — usa la vista vw_AvanceCampanias */
async function avanceCampanias(req, res, next) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`SELECT * FROM vw_AvanceCampanias ORDER BY Campania, Asesor`);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

/* GET /api/dashboard/respuestas-por-dia?dias=7|30&campaniaId=X
   Real, no depende de que la encuesta tenga campaña asignada. */
async function respuestasPorDia(req, res, next) {
  try {
    const dias = [7, 30].includes(Number(req.query.dias)) ? Number(req.query.dias) : 7;
    const { campaniaId } = req.query;

    const pool = await getPool();
    const request = pool.request().input("Dias", sql.Int, dias);

    let filtroCampania = "";
    if (campaniaId) {
      request.input("CampaniaId", sql.Int, Number(campaniaId));
      filtroCampania = "AND e.CampaniaId = @CampaniaId";
    }

    const result = await request.query(`
      SELECT
        CAST(r.FechaHoraFin AS DATE) AS Fecha,
        COUNT(*) AS Total
      FROM RespuestasEncuesta r
      JOIN Encuestas e ON e.EncuestaId = r.EncuestaId
      WHERE r.FechaHoraFin >= DATEADD(DAY, -(@Dias - 1), CAST(SYSUTCDATETIME() AS DATE))
      ${filtroCampania}
      GROUP BY CAST(r.FechaHoraFin AS DATE)
      ORDER BY Fecha
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

/* GET /api/dashboard/campanias-resumen
   Un cuadro por campaña: antigüedad desde su creación, % de avance
   real, pendientes, encuestas que la componen.

   Importante: desde que una asignación puede recibir VARIAS entrevistas
   (esquema 1 a muchos), "Finalizada" ya no es un buen indicador de
   avance por sí solo — una asignación puede tener 5 respuestas reales
   y seguir "EnCurso" porque el encuestador aún no cerró la campaña.
   Por eso el avance se mide por asignaciones que YA produjeron al
   menos una respuesta real, no por su estado formal. */
async function campaniasResumen(req, res, next) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        c.CampaniaId, c.CodigoCampania, c.Nombre, c.FechaInicio, c.Estado,
        DATEDIFF(DAY, c.FechaInicio, SYSUTCDATETIME()) AS AntiguedadDias,
        (SELECT COUNT(*) FROM Encuestas e WHERE e.CampaniaId = c.CampaniaId) AS TotalEncuestas,
        (SELECT COUNT(*) FROM Asignaciones a JOIN Encuestas e ON e.EncuestaId = a.EncuestaId WHERE e.CampaniaId = c.CampaniaId) AS TotalAsignaciones,
        (SELECT COUNT(DISTINCT a.AsignacionId)
           FROM Asignaciones a
           JOIN Encuestas e ON e.EncuestaId = a.EncuestaId
           WHERE e.CampaniaId = c.CampaniaId
             AND EXISTS (SELECT 1 FROM RespuestasEncuesta r WHERE r.AsignacionId = a.AsignacionId)
        ) AS AsignacionesConRespuesta,
        (SELECT COUNT(*) FROM Asignaciones a JOIN Encuestas e ON e.EncuestaId = a.EncuestaId WHERE e.CampaniaId = c.CampaniaId AND a.Estado = 'Finalizada') AS AsignacionesCerradas,
        (SELECT COUNT(*) FROM RespuestasEncuesta r JOIN Encuestas e ON e.EncuestaId = r.EncuestaId WHERE e.CampaniaId = c.CampaniaId) AS TotalRespuestas
      FROM Campanias c
      ORDER BY c.FechaInicio DESC
    `);

    const campanias = result.recordset.map((c) => ({
      ...c,
      Completadas: c.AsignacionesConRespuesta,
      Pendientes: Math.max(c.TotalAsignaciones - c.AsignacionesConRespuesta, 0),
      PorcentajeAvance: c.TotalAsignaciones > 0 ? Math.round((c.AsignacionesConRespuesta / c.TotalAsignaciones) * 100) : 0,
    }));

    res.json(campanias);
  } catch (err) {
    next(err);
  }
}

/* GET /api/dashboard/ranking-encuestadores
   Índice de Productividad del Encuestador (IPE) — rediseñado con
   enfoque de ingeniería industrial, basado en trazabilidad real de
   ejecución (no en el estado "Finalizada", que con el esquema 1 a
   muchos casi nunca se marca hasta que el encuestador cierra la
   campaña por su cuenta — por eso la fórmula anterior no funcionaba).

   Tres componentes, cada uno medible y accionable:

   1) Tasa de Atención (peso 50%)
      % de asignaciones que ya recibieron al menos 1 entrevista real.
      Mide si el encuestador está trabajando lo que se le asignó.

   2) Cumplimiento de SLA 24h (peso 30%)
      De las asignaciones atendidas, qué % tuvo su PRIMERA entrevista
      dentro de las 24 horas desde que se le asignó. Mide velocidad
      de reacción, no volumen.

   3) Score de Volumen (peso 20%)
      Total de entrevistas reales completadas, normalizado contra un
      objetivo de referencia (20/mes). Mide throughput real — clave
      en el esquema 1 a muchos, donde una sola asignación puede
      generar muchas entrevistas.

   IPE = 50%×Atención + 30%×SLA24h + 20%×Volumen
*/
const OBJETIVO_RESPUESTAS_MENSUAL = 20; // ajustable según lo que defina el negocio

async function rankingEncuestadores(req, res, next) {
  try {
    const pool = await getPool();
    const result = await pool.request().input("ObjetivoVolumen", OBJETIVO_RESPUESTAS_MENSUAL).query(`
      WITH PrimeraRespuestaPorAsignacion AS (
        SELECT AsignacionId, MIN(FechaHoraFin) AS PrimeraRespuesta
        FROM RespuestasEncuesta
        GROUP BY AsignacionId
      ),
      AsignacionesConSLA AS (
        SELECT
          a.AsignacionId, a.AsesorId, a.FechaAsignacion, pr.PrimeraRespuesta,
          DATEDIFF(HOUR, a.FechaAsignacion, pr.PrimeraRespuesta) AS HorasHastaPrimeraRespuesta
        FROM Asignaciones a
        LEFT JOIN PrimeraRespuestaPorAsignacion pr ON pr.AsignacionId = a.AsignacionId
      )
      SELECT
        u.UsuarioId, u.NombreCompleto, u.Correo,
        COUNT(asla.AsignacionId) AS TotalAsignadas,
        SUM(CASE WHEN asla.PrimeraRespuesta IS NOT NULL THEN 1 ELSE 0 END) AS AsignacionesAtendidas,
        SUM(CASE WHEN asla.PrimeraRespuesta IS NOT NULL AND asla.HorasHastaPrimeraRespuesta <= 24 THEN 1 ELSE 0 END) AS AsignacionesDentroSLA,
        AVG(CASE WHEN asla.PrimeraRespuesta IS NOT NULL THEN CAST(asla.HorasHastaPrimeraRespuesta AS FLOAT) END) AS HorasPromedioPrimeraAtencion,
        (SELECT COUNT(*) FROM RespuestasEncuesta r WHERE r.AsesorId = u.UsuarioId) AS TotalRespuestasGeneradas
      FROM Usuarios u
      JOIN Roles rl ON rl.RolId = u.RolId
      LEFT JOIN AsignacionesConSLA asla ON asla.AsesorId = u.UsuarioId
      WHERE rl.NombreRol = 'Encuestador'
      GROUP BY u.UsuarioId, u.NombreCompleto, u.Correo
    `);

    const ranking = result.recordset.map((r) => {
      const tasaAtencion = r.TotalAsignadas > 0 ? r.AsignacionesAtendidas / r.TotalAsignadas : 0;
      const cumplimientoSLA = r.AsignacionesAtendidas > 0 ? r.AsignacionesDentroSLA / r.AsignacionesAtendidas : 0;
      const scoreVolumen = Math.min(r.TotalRespuestasGeneradas / OBJETIVO_RESPUESTAS_MENSUAL, 1);

      const ipePct =
        r.TotalAsignadas > 0
          ? Math.round((tasaAtencion * 0.5 + cumplimientoSLA * 0.3 + scoreVolumen * 0.2) * 100)
          : null;

      return {
        UsuarioId: r.UsuarioId,
        NombreCompleto: r.NombreCompleto,
        Correo: r.Correo,
        TotalAsignadas: r.TotalAsignadas,
        AsignacionesAtendidas: r.AsignacionesAtendidas,
        AsignacionesDentroSLA: r.AsignacionesDentroSLA,
        TotalRespuestasGeneradas: r.TotalRespuestasGeneradas,
        HorasPromedioPrimeraAtencion:
          r.HorasPromedioPrimeraAtencion != null ? Math.round(r.HorasPromedioPrimeraAtencion * 10) / 10 : null,
        EfectividadPct: ipePct,
      };
    });

    ranking.sort((a, b) => (b.EfectividadPct ?? -1) - (a.EfectividadPct ?? -1));

    res.json(ranking);
  } catch (err) {
    next(err);
  }
}

module.exports = { resumen, avanceCampanias, respuestasPorDia, campaniasResumen, rankingEncuestadores };
