const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const { requireVista } = require("../middleware/requireVista");
const encuestas = require("../controllers/encuestas.controller");

router.use(requireAuth);

// listar: dato de apoyo usado también por Encuestados/Dashboard, no se gatea por vista
router.get("/", requireRole(["Administrador", "Supervisor"]), encuestas.listar);
// crear/editar/publicar: sí requieren la vista "Encuestas & preguntas" habilitada
router.post("/", requireRole(["Administrador", "Supervisor"]), requireVista("encuestas"), encuestas.crear);
router.put("/:id", requireRole(["Administrador", "Supervisor"]), requireVista("encuestas"), encuestas.guardar);
router.put("/:id/publicar", requireRole(["Administrador", "Supervisor"]), requireVista("encuestas"), encuestas.publicar);
router.delete("/:id", requireRole(["Administrador"]), encuestas.eliminar);

// detalle: también lo necesita el Encuestador para renderizar el formulario asignado — sin gate de vista
router.get("/:id", encuestas.detalle);

module.exports = router;
