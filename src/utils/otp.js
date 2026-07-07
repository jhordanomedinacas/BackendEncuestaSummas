const crypto = require("crypto");
const { smtpConfigurado, enviarCorreoOTP } = require("../config/mailer");

const OTP_LENGTH = Number(process.env.OTP_LENGTH || 6);
const OTP_EXP_MINUTES = Number(process.env.OTP_EXP_MINUTES || 5);

/** Genera un código numérico de OTP_LENGTH dígitos, ej. "483920" */
function generarCodigoOTP() {
  const max = 10 ** OTP_LENGTH;
  const num = crypto.randomInt(0, max);
  return String(num).padStart(OTP_LENGTH, "0");
}

/** El código NUNCA se guarda en texto plano — se guarda su hash SHA-256 */
function hashCodigoOTP(codigo) {
  return crypto.createHash("sha256").update(codigo).digest();
}

function fechaExpiracion() {
  return new Date(Date.now() + OTP_EXP_MINUTES * 60 * 1000);
}

/**
 * Envío del código. Si hay credenciales SMTP configuradas (.env),
 * manda un correo real. Si no, cae en modo desarrollo y solo lo
 * imprime en consola — así no se rompe nada si aún no configuraste
 * el envío de correos.
 */
async function enviarCodigoOTP(destino, codigo) {
  if (smtpConfigurado()) {
    await enviarCorreoOTP(destino, codigo);
    console.log(`[2FA] Correo real enviado a ${destino}`);
    return;
  }

  console.log(`[2FA][DEV] SMTP no configurado — código para ${destino}: ${codigo}`);
}

module.exports = { generarCodigoOTP, hashCodigoOTP, fechaExpiracion, enviarCodigoOTP };
