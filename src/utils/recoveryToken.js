const crypto = require("crypto");

const TOKEN_EXP_MINUTES = Number(process.env.RECOVERY_TOKEN_EXP_MINUTES || 30);

/** Token largo y aleatorio (va en el link del correo, nunca en la BD) */
function generarTokenRecuperacion() {
  return crypto.randomBytes(32).toString("hex"); // 64 caracteres
}

function hashTokenRecuperacion(token) {
  return crypto.createHash("sha256").update(token).digest();
}

function fechaExpiracionToken() {
  return new Date(Date.now() + TOKEN_EXP_MINUTES * 60 * 1000);
}

module.exports = { generarTokenRecuperacion, hashTokenRecuperacion, fechaExpiracionToken, TOKEN_EXP_MINUTES };
