const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const { requireVista } = require("../middleware/requireVista");
const dashboard = require("../controllers/dashboard.controller");

router.use(requireAuth, requireRole(["Administrador", "Supervisor"]), requireVista("dashboard"));

router.get("/resumen", dashboard.resumen);
router.get("/avance-campanias", dashboard.avanceCampanias);
router.get("/respuestas-por-dia", dashboard.respuestasPorDia);
router.get("/campanias-resumen", dashboard.campaniasResumen);
router.get("/ranking-encuestadores", dashboard.rankingEncuestadores);

module.exports = router;
