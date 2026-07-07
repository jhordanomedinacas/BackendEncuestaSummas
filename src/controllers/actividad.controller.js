const { getPool } = require("../config/db");

/* GET /api/actividad
   Bitácora de acciones de Administrador/Supervisor (creación/edición/
   eliminación de encuestas, campañas, usuarios, asignación de roles).
   NO incluye actividad de Encuestadores (eso vive en Encuestados). */
async function listar(req, res, next) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT TOP 1000
        al.LogId, al.Accion, al.Entidad, al.EntidadId, al.Detalle,
        al.Latitud, al.Longitud, al.Departamento, al.Distrito, al.DireccionIP, al.FechaHora,
        u.NombreCompleto, u.Correo, r.NombreRol AS Rol
      FROM AuditLog al
      LEFT JOIN Usuarios u ON u.UsuarioId = al.UsuarioId
      LEFT JOIN Roles r ON r.RolId = u.RolId
      WHERE r.NombreRol IN ('Administrador', 'Supervisor')
      ORDER BY al.FechaHora DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

module.exports = { listar };
