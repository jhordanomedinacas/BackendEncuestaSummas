const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const { requireVista } = require("../middleware/requireVista");
const asignaciones = require("../controllers/asignaciones.controller");

router.use(requireAuth);

// asignar encuestas a un encuestador vive en la pantalla de Usuarios — solo Administrador
// asignar encuestas: ahora también el Supervisor (necesario porque no tiene
// acceso a Usuarios — lo hace desde el propio constructor de Encuestas)
router.post("/masiva", requireRole(["Administrador", "Supervisor"]), requireVista("encuestas"), asignaciones.asignarMasivo);
router.get("/usuario/:usuarioId", requireRole(["Administrador"]), asignaciones.obtenerPorUsuario);
router.get("/encuesta/:encuestaId", requireRole(["Administrador", "Supervisor"]), requireVista("encuestas"), asignaciones.obtenerPorEncuesta);
router.get("/encuestadores", requireRole(["Administrador", "Supervisor"]), requireVista("encuestas"), asignaciones.listarEncuestadores);
router.get("/pendientes", requireRole(["Administrador", "Supervisor"]), requireVista("encuestados"), asignaciones.pendientesGlobal);
router.delete("/:id", requireRole(["Administrador", "Supervisor"]), asignaciones.eliminar);
router.get("/mis-encuestas", asignaciones.misEncuestas); // Encuestador: sus propias encuestas
router.put("/:id/iniciar", asignaciones.iniciar);        // Encuestador: al abrir el formulario
router.put("/:id/finalizar", requireRole(["Administrador", "Supervisor"]), asignaciones.finalizar); // solo Admin/Supervisor cierran una campaña

module.exports = router;
