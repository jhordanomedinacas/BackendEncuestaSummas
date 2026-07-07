const { sql } = require("../config/db");

/**
 * Registra una actividad del Administrador/Supervisor en AuditLog.
 * @param {object} pool     pool de conexión ya obtenido con getPool()
 * @param {object} datos
 * @param {number} datos.usuarioId
 * @param {string} datos.accion     código corto, ej. 'CREAR_ENCUESTA'
 * @param {string} [datos.entidad]  ej. 'Encuestas', 'Usuarios', 'Campanias'
 * @param {string|number} [datos.entidadId]
 * @param {string} [datos.detalle]  frase legible para humanos
 * @param {object} [datos.req]      request de Express — de aquí se
 *                                  sacan IP y la geolocalización
 *                                  "mejor esfuerzo" (headers X-Geo-Lat/Lng)
 */
async function registrarActividad(pool, { usuarioId, accion, entidad, entidadId, detalle, req }) {
  const lat = req?.headers["x-geo-lat"] ? Number(req.headers["x-geo-lat"]) : null;
  const lng = req?.headers["x-geo-lng"] ? Number(req.headers["x-geo-lng"]) : null;
  const departamento = req?.headers["x-geo-departamento"] ? decodeURIComponent(req.headers["x-geo-departamento"]) : null;
  const distrito = req?.headers["x-geo-distrito"] ? decodeURIComponent(req.headers["x-geo-distrito"]) : null;
  const ip = req?.ip || null;

  try {
    await pool
      .request()
      .input("UsuarioId", sql.Int, usuarioId)
      .input("Accion", sql.NVarChar(100), accion)
      .input("Entidad", sql.NVarChar(50), entidad || null)
      .input("EntidadId", sql.NVarChar(50), entidadId != null ? String(entidadId) : null)
      .input("Detalle", sql.NVarChar(500), detalle || null)
      .input("Latitud", sql.Decimal(9, 6), Number.isFinite(lat) ? lat : null)
      .input("Longitud", sql.Decimal(9, 6), Number.isFinite(lng) ? lng : null)
      .input("Departamento", sql.NVarChar(100), departamento)
      .input("Distrito", sql.NVarChar(100), distrito)
      .input("DireccionIP", sql.NVarChar(45), ip)
      .query(`
        INSERT INTO AuditLog (UsuarioId, Accion, Entidad, EntidadId, Detalle, Latitud, Longitud, Departamento, Distrito, DireccionIP)
        VALUES (@UsuarioId, @Accion, @Entidad, @EntidadId, @Detalle, @Latitud, @Longitud, @Departamento, @Distrito, @DireccionIP)
      `);

    // Retención: solo se guardan las últimas 1000 acciones de Admin/Supervisor;
    // las más antiguas se eliminan automáticamente (no aplica a la actividad
    // de Encuestadores, que vive aparte para la trazabilidad de encuestas).
    await pool.request().query(`
      DELETE FROM AuditLog
      WHERE LogId IN (
        SELECT al.LogId
        FROM AuditLog al
        JOIN Usuarios u ON u.UsuarioId = al.UsuarioId
        JOIN Roles r ON r.RolId = u.RolId
        WHERE r.NombreRol IN ('Administrador','Supervisor')
        ORDER BY al.FechaHora DESC
        OFFSET 1000 ROWS FETCH NEXT 1000000 ROWS ONLY
      )
    `);
  } catch (err) {
    // la auditoría nunca debe tumbar la operación principal
    console.error("[auditoria] no se pudo registrar:", err.message);
  }
}

module.exports = { registrarActividad };
