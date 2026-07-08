const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const { requireVista } = require("../middleware/requireVista");
const usuarios = require("../controllers/usuarios.controller");

// lista liviana de encuestadores: también la usa el Supervisor desde "Encuestas & preguntas"
router.get(
  "/encuestadores",
  requireAuth,
  requireRole(["Administrador", "Supervisor"]),
  requireVista("encuestas"),
  usuarios.listarEncuestadores
);

// gestión completa de usuarios: solo Administrador
router.use(requireAuth, requireRole(["Administrador"]));

router.get("/", usuarios.listar);
router.post("/", usuarios.crear);
router.put("/:id", usuarios.actualizar);
router.delete("/:id", usuarios.eliminar);

module.exports = router;
