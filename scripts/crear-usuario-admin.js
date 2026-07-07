/**
 * Crea (o resetea la contraseña de) un usuario administrador con un
 * hash real — el usuario del seed (02_datos_semilla.sql) trae
 * PasswordHash = 0x00 a propósito, solo como placeholder, y NO sirve
 * para iniciar sesión.
 *
 * Uso:
 *   node scripts/crear-usuario-admin.js correo@empresa.com "MiClave123!" "Nombre Completo" Administrador
 *
 * El último parámetro (rol) es opcional, por defecto "Administrador".
 */
require("dotenv").config();
const { sql, getPool } = require("../src/config/db");
const { hashPassword } = require("../src/utils/password");

async function main() {
  const [correo, password, nombreCompleto = "Usuario Admin", rol = "Administrador"] = process.argv.slice(2);

  if (!correo || !password) {
    console.error('Uso: node scripts/crear-usuario-admin.js correo password "Nombre Completo" [Rol]');
    process.exit(1);
  }

  const pool = await getPool();

  const rolResult = await pool
    .request()
    .input("NombreRol", sql.NVarChar(50), rol)
    .query(`SELECT RolId FROM Roles WHERE NombreRol = @NombreRol`);

  if (rolResult.recordset.length === 0) {
    console.error(`El rol "${rol}" no existe. Corre primero 01_schema...sql y 02_datos_semilla.sql.`);
    process.exit(1);
  }
  const rolId = rolResult.recordset[0].RolId;

  const { hash, salt } = hashPassword(password);

  const existe = await pool
    .request()
    .input("Correo", sql.NVarChar(150), correo)
    .query(`SELECT UsuarioId FROM Usuarios WHERE Correo = @Correo`);

  if (existe.recordset.length > 0) {
    await pool
      .request()
      .input("Correo", sql.NVarChar(150), correo)
      .input("PasswordHash", sql.VarBinary(256), hash)
      .input("PasswordSalt", sql.VarBinary(128), salt)
      .input("RolId", sql.Int, rolId)
      .query(`
        UPDATE Usuarios
        SET PasswordHash = @PasswordHash, PasswordSalt = @PasswordSalt, RolId = @RolId, Estado = 'Activo'
        WHERE Correo = @Correo
      `);
    console.log(`Contraseña actualizada para ${correo}.`);
  } else {
    await pool
      .request()
      .input("NombreCompleto", sql.NVarChar(150), nombreCompleto)
      .input("Correo", sql.NVarChar(150), correo)
      .input("PasswordHash", sql.VarBinary(256), hash)
      .input("PasswordSalt", sql.VarBinary(128), salt)
      .input("RolId", sql.Int, rolId)
      .query(`
        INSERT INTO Usuarios (NombreCompleto, Correo, PasswordHash, PasswordSalt, RolId)
        VALUES (@NombreCompleto, @Correo, @PasswordHash, @PasswordSalt, @RolId)
      `);
    console.log(`Usuario ${correo} creado con rol ${rol}.`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
