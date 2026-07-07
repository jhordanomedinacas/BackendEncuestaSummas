const nodemailer = require("nodemailer");

let transporterInstance = null;

function smtpConfigurado() {
  return !!(process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (!transporterInstance) {
    const port = Number(process.env.SMTP_PORT || 465);
    transporterInstance = nodemailer.createTransport({
      host: process.env.SMTP_HOST || "smtp.gmail.com",
      port,
      secure: port === 465, // 465 = TLS directo (Gmail); 587 = STARTTLS (Office365/Outlook)
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporterInstance;
}

/**
 * Envía el correo real con el código OTP.
 * @param {string} destino  correo del usuario
 * @param {string} codigo   código de 6 dígitos
 */
async function enviarCorreoOTP(destino, codigo) {
  const transporter = getTransporter();

  await transporter.sendMail({
    from: `"Panel de Encuestas" <${process.env.SMTP_USER}>`,
    to: destino,
    subject: `Tu código de verificación: ${codigo}`,
    text: `Tu código de verificación es: ${codigo}\nExpira en ${process.env.OTP_EXP_MINUTES || 5} minutos.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px;border:1px solid #e6eaf0;border-radius:12px;">
        <h2 style="color:#0d2c4f;margin-bottom:4px;">Verificación de dos pasos</h2>
        <p style="color:#5f6368;font-size:14px;">Usa este código para completar tu inicio de sesión:</p>
        <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#0078c9;text-align:center;padding:16px 0;">
          ${codigo}
        </div>
        <p style="color:#5f6368;font-size:12px;">Expira en ${process.env.OTP_EXP_MINUTES || 5} minutos. Si no solicitaste este código, ignora este correo.</p>
      </div>
    `,
  });
}

/**
 * Envía el correo con el código para restablecer la contraseña
 * (mismo estilo que el código de 2FA, para consistencia de UX).
 * @param {string} destino  correo del usuario
 * @param {string} nombre   nombre completo del usuario (saludo personalizado)
 * @param {string} codigo   código de 6 dígitos
 */
async function enviarCorreoRecuperacion(destino, nombre, codigo) {
  const transporter = getTransporter();
  const minutos = process.env.RECOVERY_TOKEN_EXP_MINUTES || 30;

  await transporter.sendMail({
    from: `"Panel de Encuestas" <${process.env.SMTP_USER}>`,
    to: destino,
    subject: `Tu código para restablecer tu contraseña: ${codigo}`,
    text: `Hola ${nombre}, tu código para restablecer tu contraseña es: ${codigo}\nExpira en ${minutos} minutos. Si no lo solicitaste, ignora este correo.`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:420px;margin:0 auto;padding:24px;border:1px solid #e6eaf0;border-radius:12px;">
        <h2 style="color:#0d2c4f;margin-bottom:4px;">Restablecer contraseña</h2>
        <p style="color:#5f6368;font-size:14px;">Hola ${nombre}, usa este código para continuar:</p>
        <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#0078c9;text-align:center;padding:16px 0;">
          ${codigo}
        </div>
        <p style="color:#5f6368;font-size:12px;">Expira en ${minutos} minutos. Si no solicitaste esto, ignora este correo — tu contraseña actual sigue siendo válida.</p>
      </div>
    `,
  });
}

module.exports = { smtpConfigurado, enviarCorreoOTP, enviarCorreoRecuperacion };
