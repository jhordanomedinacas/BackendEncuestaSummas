const rateLimit = require("express-rate-limit");

/** Login: pocas veces por IP en poco tiempo — evita fuerza bruta de contraseñas */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: { error: "Demasiados intentos de inicio de sesión. Intenta de nuevo en unos minutos." },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Verificación de código (2FA o recuperación): un código de 6 dígitos
 *  solo tiene 1,000,000 combinaciones — sin límite de intentos, se
 *  podría adivinar por fuerza bruta en minutos. */
const codigoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: "Demasiados intentos. Espera unos minutos antes de volver a intentar." },
  standardHeaders: true,
  legacyHeaders: false,
});

/** Solicitar recuperación: evita que se pueda usar para hacer spam de
 *  correos hacia terceros o para tantear qué correos existen a fuerza
 *  de repetir la petición muchas veces. */
const recuperarLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Demasiadas solicitudes de recuperación. Intenta de nuevo más tarde." },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { loginLimiter, codigoLimiter, recuperarLimiter };
