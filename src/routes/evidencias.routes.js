const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const { requireVista } = require("../middleware/requireVista");
const evidencias = require("../controllers/evidencias.controller");

router.use(requireAuth, requireRole(["Administrador", "Supervisor"]), requireVista("encuestados"));

router.get("/", evidencias.listar);
router.get("/exportar", evidencias.exportarExcel);
router.get("/:respuestaId", evidencias.detalle);
router.put("/:respuestaId/estado-auditoria", evidencias.actualizarEstadoAuditoria);
router.delete("/:respuestaId", evidencias.eliminarRespuesta);

module.exports = router;
