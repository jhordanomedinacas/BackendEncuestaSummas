const crypto = require("crypto");

const ITERATIONS = 100000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";

/**
 * Genera hash + salt para una contraseña nueva.
 * Coincide con las columnas Usuarios.PasswordHash / PasswordSalt
 * (VARBINARY) del esquema SQL Server.
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  return { hash, salt };
}

/**
 * Verifica una contraseña contra el hash/salt guardados.
 * @param {string} password  contraseña en texto plano ingresada en el login
 * @param {Buffer} storedHash
 * @param {Buffer} storedSalt
 */
function verifyPassword(password, storedHash, storedSalt) {
  const attempt = crypto.pbkdf2Sync(password, storedSalt, ITERATIONS, KEY_LENGTH, DIGEST);
  if (attempt.length !== storedHash.length) return false;
  return crypto.timingSafeEqual(attempt, storedHash);
}

module.exports = { hashPassword, verifyPassword };
