const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const { requireVista } = require("../middleware/requireVista");
const asignaciones = require("../controllers/asignaciones.controller");

router.use(requireAuth);

// asignar encuestas a un encuestador vive en la pantalla de Usuarios — solo Administrador
router.post("/masiva", requireRole(["Administrador"]), asignaciones.asignarMasivo);
router.get("/usuario/:usuarioId", requireRole(["Administrador"]), asignaciones.obtenerPorUsuario);
router.get("/pendientes", requireRole(["Administrador", "Supervisor"]), requireVista("encuestados"), asignaciones.pendientesGlobal);
router.delete("/:id", requireRole(["Administrador", "Supervisor"]), asignaciones.eliminar);
router.get("/mis-encuestas", asignaciones.misEncuestas); // Encuestador: sus propias encuestas
router.put("/:id/iniciar", asignaciones.iniciar);        // Encuestador: al abrir el formulario
router.put("/:id/finalizar", asignaciones.finalizar);    // Encuestador: cuando termina de encuestar a todas las personas

module.exports = router;
