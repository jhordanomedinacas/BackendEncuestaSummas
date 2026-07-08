const jwt = require("jsonwebtoken");
const { sql, getPool } = require("../config/db");
const { verifyPassword, hashPassword } = require("../utils/password");
const { generarCodigoOTP, hashCodigoOTP, fechaExpiracion, enviarCodigoOTP } = require("../utils/otp");
const { fechaExpiracionToken } = require("../utils/recoveryToken");
const { enviarCorreoRecuperacion } = require("../config/mailer");

function firmarToken(usuario) {
  return jwt.sign(
    {
      usuarioId: usuario.UsuarioId,
      correo: usuario.Correo,
      rol: usuario.NombreRol,
      vistasPermitidas: parseVistas(usuario.VistasPermitidas),
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
  );
}

function parseVistas(csv) {
  if (!csv) return [];
  return csv.split(",").map((v) => v.trim()).filter(Boolean);
}

async function registrarAuditoria(pool, usuarioId, accion, req) {
  await pool
    .request()
    .input("UsuarioId", sql.Int, usuarioId)
    .input("Accion", sql.NVarChar(100), accion)
    .input("Entidad", sql.NVarChar(50), "Usuarios")
    .input("EntidadId", sql.NVarChar(50), String(usuarioId))
    .input("DireccionIP", sql.NVarChar(45), req.ip)
    .query(
      `INSERT INTO AuditLog (UsuarioId, Accion, Entidad, EntidadId, DireccionIP)
       VALUES (@UsuarioId, @Accion, @Entidad, @EntidadId, @DireccionIP)`
    );
}

/* ---------------------------------------------------------------
   POST /api/auth/login  { correo, password }
--------------------------------------------------------------- */
async function login(req, res, next) {
  try {
    const { correo, password } = req.body;
    if (!correo || !password) {
      return res.status(400).json({ error: "Correo y contraseña son obligatorios." });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("Correo", sql.NVarChar(150), correo)
      .execute("sp_ValidarUsuario");

    if (result.recordset.length === 0) {
      // mensaje genérico: no revelar si el correo existe o no
      return res.status(401).json({ error: "Credenciales inválidas." });
    }

    const usuario = result.recordset[0];
    const claveValida = verifyPassword(password, usuario.PasswordHash, usuario.PasswordSalt);
    if (!claveValida) {
      return res.status(401).json({ error: "Credenciales inválidas." });
    }

    if (!usuario.Requiere2FA) {
      const token = firmarToken(usuario);
      await registrarAuditoria(pool, usuario.UsuarioId, "LOGIN_OK_SIN_2FA", req);
      return res.json({ requiere2FA: false, token, usuario: publicUser(usuario) });
    }

    // Genera y guarda el OTP
    const codigo = generarCodigoOTP();
    const codigoHash = hashCodigoOTP(codigo);
    await pool
      .request()
      .input("UsuarioId", sql.Int, usuario.UsuarioId)
      .input("CodigoHash", sql.VarBinary(256), codigoHash)
      .input("FechaExpira", sql.DateTime2, fechaExpiracion())
      .query(
        `INSERT INTO Usuarios2FACodigos (UsuarioId, CodigoHash, FechaExpira)
         VALUES (@UsuarioId, @CodigoHash, @FechaExpira)`
      );

    // Responde de inmediato — el código ya quedó guardado y es válido.
    // El correo se manda en paralelo, sin que el usuario tenga que
    // esperar a que termine el handshake SMTP (antes tardaba ~17s).
    enviarCodigoOTP(usuario.Correo, codigo, "Email").catch((err) =>
      console.error("[2FA] No se pudo enviar el correo:", err.message)
    );

    return res.json({ requiere2FA: true, usuarioId: usuario.UsuarioId });
  } catch (err) {
    next(err);
  }
}

/* ---------------------------------------------------------------
   POST /api/auth/verify-2fa  { usuarioId, codigo }
--------------------------------------------------------------- */
async function verify2FA(req, res, next) {
  try {
    const { usuarioId, codigo } = req.body;
    if (!usuarioId || !codigo) {
      return res.status(400).json({ error: "usuarioId y codigo son obligatorios." });
    }

    const pool = await getPool();
    const codigoHash = hashCodigoOTP(codigo);

    const result = await pool
      .request()
      .input("UsuarioId", sql.Int, usuarioId)
      .input("CodigoHash", sql.VarBinary(256), codigoHash)
      .query(
        `SELECT TOP 1 CodigoId
         FROM Usuarios2FACodigos
         WHERE UsuarioId = @UsuarioId
           AND CodigoHash = @CodigoHash
           AND Usado = 0
           AND FechaExpira > SYSUTCDATETIME()
         ORDER BY FechaEmision DESC`
      );

    if (result.recordset.length === 0) {
      await registrarAuditoria(pool, usuarioId, "LOGIN_FAIL_2FA", req);
      return res.status(401).json({ error: "Código incorrecto o expirado." });
    }

    await pool
      .request()
      .input("CodigoId", sql.BigInt, result.recordset[0].CodigoId)
      .query(`UPDATE Usuarios2FACodigos SET Usado = 1 WHERE CodigoId = @CodigoId`);

    const userResult = await pool
      .request()
      .input("UsuarioId", sql.Int, usuarioId)
      .query(
        `SELECT u.UsuarioId, u.NombreCompleto, u.Correo, u.VistasPermitidas, r.NombreRol
         FROM Usuarios u JOIN Roles r ON r.RolId = u.RolId
         WHERE u.UsuarioId = @UsuarioId`
      );
    const usuario = userResult.recordset[0];

    await pool
      .request()
      .input("UsuarioId", sql.Int, usuarioId)
      .query(`UPDATE Usuarios SET UltimoAcceso = SYSUTCDATETIME() WHERE UsuarioId = @UsuarioId`);

    const token = firmarToken(usuario);
    await registrarAuditoria(pool, usuarioId, "LOGIN_OK", req);

    return res.json({ token, usuario: publicUser(usuario) });
  } catch (err) {
    next(err);
  }
}

function publicUser(usuario) {
  return {
    usuarioId: usuario.UsuarioId,
    nombreCompleto: usuario.NombreCompleto,
    correo: usuario.Correo,
    rol: usuario.NombreRol,
    vistasPermitidas: parseVistas(usuario.VistasPermitidas),
  };
}

/* ---------------------------------------------------------------
   POST /api/auth/recuperar  { correo }
   Respuesta SIEMPRE genérica — nunca revela si el correo existe.
   Igual que el 2FA: se manda un código de 6 dígitos por correo.
--------------------------------------------------------------- */
async function solicitarRecuperacion(req, res, next) {
  try {
    const { correo } = req.body;
    if (!correo) {
      return res.status(400).json({ error: "El correo es obligatorio." });
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input("Correo", sql.NVarChar(150), correo)
      .query(`SELECT UsuarioId, NombreCompleto, Correo FROM Usuarios WHERE Correo = @Correo AND Estado = 'Activo'`);

    // Solo generamos/enviamos el código si el usuario realmente existe —
    // pero la respuesta HTTP es idéntica en ambos casos.
    if (result.recordset.length > 0) {
      const usuario = result.recordset[0];
      const codigo = generarCodigoOTP();
      const codigoHash = hashCodigoOTP(codigo);

      await pool
        .request()
        .input("UsuarioId", sql.Int, usuario.UsuarioId)
        .input("TokenHash", sql.VarBinary(256), codigoHash)
        .input("FechaExpira", sql.DateTime2, fechaExpiracionToken())
        .query(`
          INSERT INTO RecuperacionTokens (UsuarioId, TokenHash, FechaExpira)
          VALUES (@UsuarioId, @TokenHash, @FechaExpira)
        `);

      enviarCorreoRecuperacion(usuario.Correo, usuario.NombreCompleto, codigo).catch((err) =>
        console.error("[recuperación] No se pudo enviar el correo:", err.message)
      );
    }

    return res.json({
      ok: true,
      mensaje: "Si el correo está registrado, te enviamos un código para restablecer tu contraseña.",
    });
  } catch (err) {
    next(err);
  }
}

/* ---------------------------------------------------------------
   POST /api/auth/restablecer  { correo, codigo, nuevaContrasena }
   Valida el código (igual que el 2FA) + actualiza la contraseña.
--------------------------------------------------------------- */
async function restablecerPassword(req, res, next) {
  try {
    const { correo, codigo, nuevaContrasena } = req.body;
    if (!correo || !codigo || !nuevaContrasena) {
      return res.status(400).json({ error: "Correo, código y nueva contraseña son obligatorios." });
    }
    if (nuevaContrasena.trim().length < 8) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres." });
    }

    const pool = await getPool();

    // igual que en solicitarRecuperacion: no revelamos si el correo existe
    const userResult = await pool
      .request()
      .input("Correo", sql.NVarChar(150), correo)
      .query(`SELECT UsuarioId FROM Usuarios WHERE Correo = @Correo AND Estado = 'Activo'`);

    if (userResult.recordset.length === 0) {
      return res.json({ ok: false, mensaje: "El código no es válido o ya expiró." });
    }
    const usuarioId = userResult.recordset[0].UsuarioId;
    const codigoHash = hashCodigoOTP(codigo);

    const tokenResult = await pool
      .request()
      .input("UsuarioId", sql.Int, usuarioId)
      .input("TokenHash", sql.VarBinary(256), codigoHash)
      .query(`
        SELECT TOP 1 TokenId FROM RecuperacionTokens
        WHERE UsuarioId = @UsuarioId AND TokenHash = @TokenHash AND Usado = 0 AND FechaExpira > SYSUTCDATETIME()
        ORDER BY FechaEmision DESC
      `);

    if (tokenResult.recordset.length === 0) {
      return res.json({ ok: false, mensaje: "El código no es válido o ya expiró." });
    }

    const { hash, salt } = hashPassword(nuevaContrasena);

    await pool
      .request()
      .input("UsuarioId", sql.Int, usuarioId)
      .input("PasswordHash", sql.VarBinary(256), hash)
      .input("PasswordSalt", sql.VarBinary(128), salt)
      .query(`UPDATE Usuarios SET PasswordHash = @PasswordHash, PasswordSalt = @PasswordSalt WHERE UsuarioId = @UsuarioId`);

    await pool
      .request()
      .input("TokenId", sql.BigInt, tokenResult.recordset[0].TokenId)
      .query(`UPDATE RecuperacionTokens SET Usado = 1 WHERE TokenId = @TokenId`);

    await registrarAuditoria(pool, usuarioId, "PASSWORD_RESTABLECIDA", req);

    return res.json({ ok: true, mensaje: "Contraseña actualizada correctamente." });
  } catch (err) {
    next(err);
  }
}

module.exports = { login, verify2FA, solicitarRecuperacion, restablecerPassword };
