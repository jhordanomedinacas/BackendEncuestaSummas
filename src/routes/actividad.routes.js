const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const { requireVista } = require("../middleware/requireVista");
const actividad = require("../controllers/actividad.controller");

router.use(requireAuth, requireRole(["Administrador", "Supervisor"]), requireVista("actividad"));

router.get("/", actividad.listar);

module.exports = router;
