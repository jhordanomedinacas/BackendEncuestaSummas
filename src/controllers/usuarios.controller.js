const { sql, getPool } = require("../config/db");
const { hashPassword } = require("../utils/password");
const { registrarActividad } = require("../utils/auditoria");

const VISTAS_VALIDAS = ["dashboard", "encuestas", "encuestados", "actividad"];

function normalizarVistas(vistasPermitidas, rol) {
  if (rol !== "Supervisor") return null; // solo aplica a Supervisor
  if (!Array.isArray(vistasPermitidas)) return "";
  const limpias = vistasPermitidas.filter((v) => VISTAS_VALIDAS.includes(v));
  return limpias.join(",");
}

/* GET /api/usuarios */
async function listar(req, res, next) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT u.UsuarioId, u.NombreCompleto, u.Correo, r.NombreRol AS Rol,
             u.Estado, u.UltimoAcceso, u.FechaCreacion, u.VistasPermitidas
      FROM Usuarios u
      JOIN Roles r ON r.RolId = u.RolId
      ORDER BY u.FechaCreacion DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

/* POST /api/usuarios  { nombreCompleto, correo, rol, passwordTemporal, vistasPermitidas? } */
async function crear(req, res, next) {
  try {
    const { nombreCompleto, correo, rol, passwordTemporal, vistasPermitidas } = req.body;
    if (!nombreCompleto || !correo || !rol || !passwordTemporal) {
      return res.status(400).json({ error: "Todos los campos son obligatorios." });
    }

    const pool = await getPool();

    const rolResult = await pool
      .request()
      .input("NombreRol", sql.NVarChar(50), rol)
      .query(`SELECT RolId FROM Roles WHERE NombreRol = @NombreRol`);
    if (rolResult.recordset.length === 0) {
      return res.status(400).json({ error: `Rol "${rol}" no existe.` });
    }

    const existe = await pool
      .request()
      .input("Correo", sql.NVarChar(150), correo)
      .query(`SELECT UsuarioId FROM Usuarios WHERE Correo = @Correo`);
    if (existe.recordset.length > 0) {
      return res.status(409).json({ error: "Ya existe un usuario con ese correo." });
    }

    const { hash, salt } = hashPassword(passwordTemporal);
    const vistasCsv = normalizarVistas(vistasPermitidas, rol);

    const insert = await pool
      .request()
      .input("NombreCompleto", sql.NVarChar(150), nombreCompleto)
      .input("Correo", sql.NVarChar(150), correo)
      .input("PasswordHash", sql.VarBinary(256), hash)
      .input("PasswordSalt", sql.VarBinary(128), salt)
      .input("RolId", sql.Int, rolResult.recordset[0].RolId)
      .input("VistasPermitidas", sql.NVarChar(200), vistasCsv)
      .query(`
        INSERT INTO Usuarios (NombreCompleto, Correo, PasswordHash, PasswordSalt, RolId, VistasPermitidas)
        OUTPUT INSERTED.UsuarioId
        VALUES (@NombreCompleto, @Correo, @PasswordHash, @PasswordSalt, @RolId, @VistasPermitidas)
      `);

    res.status(201).json({ usuarioId: insert.recordset[0].UsuarioId });

    registrarActividad(pool, {
      usuarioId: req.user.usuarioId,
      accion: "CREAR_USUARIO",
      entidad: "Usuarios",
      entidadId: insert.recordset[0].UsuarioId,
      detalle: `Creó al usuario "${nombreCompleto}" (${correo}) — rol otorgado: ${rol}${vistasCsv ? `, con acceso a: ${vistasCsv}` : ""}`,
      req,
    });
  } catch (err) {
    next(err);
  }
}

/* PUT /api/usuarios/:id  { nombreCompleto, rol, estado, vistasPermitidas? } */
async function actualizar(req, res, next) {
  try {
    const { id } = req.params;
    const { nombreCompleto, rol, estado, vistasPermitidas } = req.body;

    const pool = await getPool();
    const rolResult = await pool
      .request()
      .input("NombreRol", sql.NVarChar(50), rol)
      .query(`SELECT RolId FROM Roles WHERE NombreRol = @NombreRol`);
    if (rolResult.recordset.length === 0) {
      return res.status(400).json({ error: `Rol "${rol}" no existe.` });
    }

    const vistasCsv = normalizarVistas(vistasPermitidas, rol);

    await pool
      .request()
      .input("UsuarioId", sql.Int, id)
      .input("NombreCompleto", sql.NVarChar(150), nombreCompleto)
      .input("RolId", sql.Int, rolResult.recordset[0].RolId)
      .input("Estado", sql.NVarChar(20), estado)
      .input("VistasPermitidas", sql.NVarChar(200), vistasCsv)
      .query(`
        UPDATE Usuarios
        SET NombreCompleto = @NombreCompleto, RolId = @RolId, Estado = @Estado, VistasPermitidas = @VistasPermitidas
        WHERE UsuarioId = @UsuarioId
      `);

    res.json({ ok: true });

    registrarActividad(pool, {
      usuarioId: req.user.usuarioId,
      accion: "EDITAR_USUARIO",
      entidad: "Usuarios",
      entidadId: id,
      detalle: `Editó al usuario "${nombreCompleto}" — rol: ${rol}, estado: ${estado}${vistasCsv ? `, acceso a: ${vistasCsv}` : ""}`,
      req,
    });
  } catch (err) {
    next(err);
  }
}

/* DELETE /api/usuarios/:id
   Borrado real. Si el usuario tiene registros vinculados que importan
   para la trazabilidad (encuestas/campañas creadas, asignaciones,
   respuestas), NO se borra —se avisa y se sugiere desactivar en su
   lugar— para no dejar huérfanos esos registros. */
async function eliminar(req, res, next) {
  try {
    const { id } = req.params;
    const pool = await getPool();

    const bloqueos = await pool
      .request()
      .input("UsuarioId", sql.Int, id)
      .query(`
        SELECT
          (SELECT COUNT(*) FROM Asignaciones WHERE AsesorId = @UsuarioId) AS asignaciones,
          (SELECT COUNT(*) FROM RespuestasEncuesta WHERE AsesorId = @UsuarioId) AS respuestas,
          (SELECT COUNT(*) FROM Encuestas WHERE CreadoPor = @UsuarioId) AS encuestas,
          (SELECT COUNT(*) FROM Campanias WHERE CreadaPor = @UsuarioId) AS campanias
      `);

    const r = bloqueos.recordset[0];
    const tieneVinculos = r.asignaciones > 0 || r.respuestas > 0 || r.encuestas > 0 || r.campanias > 0;

    if (tieneVinculos) {
      return res.status(409).json({
        error:
          "No se puede eliminar: este usuario tiene encuestas, campañas, asignaciones o respuestas vinculadas. Desactívalo en su lugar para no perder ese historial.",
      });
    }

    // capturamos su nombre/correo ANTES de borrar — después de borrado, el
    // registro de actividad no podría volver a consultarlo por su ID
    const datosUsuario = await pool
      .request()
      .input("UsuarioId", sql.Int, id)
      .query(`SELECT NombreCompleto, Correo FROM Usuarios WHERE UsuarioId = @UsuarioId`);
    const { NombreCompleto, Correo } = datosUsuario.recordset[0] || {};

    // sin vínculos de negocio: limpia los artefactos de autenticación y borra de verdad
    await pool.request().input("UsuarioId", sql.Int, id).query(`DELETE FROM Usuarios2FACodigos WHERE UsuarioId = @UsuarioId`);
    await pool.request().input("UsuarioId", sql.Int, id).query(`DELETE FROM RecuperacionTokens WHERE UsuarioId = @UsuarioId`);
    await pool.request().input("UsuarioId", sql.Int, id).query(`DELETE FROM AuditLog WHERE UsuarioId = @UsuarioId`);
    await pool.request().input("UsuarioId", sql.Int, id).query(`DELETE FROM Usuarios WHERE UsuarioId = @UsuarioId`);

    res.json({ ok: true });

    registrarActividad(pool, {
      usuarioId: req.user.usuarioId,
      accion: "ELIMINAR_USUARIO",
      entidad: "Usuarios",
      entidadId: id,
      detalle: `Eliminó por completo al usuario "${NombreCompleto || "desconocido"}" (${Correo || "correo no disponible"})`,
      req,
    });
  } catch (err) {
    next(err);
  }
}

/* GET /api/usuarios/encuestadores
   Lista liviana (solo nombre/correo) de usuarios con rol Encuestador —
   la usa el Supervisor desde "Encuestas & preguntas" para asignar,
   sin necesitar acceso a la gestión completa de Usuarios. */
async function listarEncuestadores(req, res, next) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT u.UsuarioId, u.NombreCompleto, u.Correo
      FROM Usuarios u
      JOIN Roles r ON r.RolId = u.RolId
      WHERE r.NombreRol = 'Encuestador' AND u.Estado = 'Activo'
      ORDER BY u.NombreCompleto
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

module.exports = { listar, crear, actualizar, eliminar, listarEncuestadores };
