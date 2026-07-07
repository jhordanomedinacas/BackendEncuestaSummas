const express = require("express");
const router = express.Router();
const { login, verify2FA, solicitarRecuperacion, restablecerPassword } = require("../controllers/auth.controller");
const { loginLimiter, codigoLimiter, recuperarLimiter } = require("../middleware/rateLimiters");

router.post("/login", loginLimiter, login);
router.post("/verify-2fa", codigoLimiter, verify2FA);
router.post("/recuperar", recuperarLimiter, solicitarRecuperacion);
router.post("/restablecer", codigoLimiter, restablecerPassword);

module.exports = router;
