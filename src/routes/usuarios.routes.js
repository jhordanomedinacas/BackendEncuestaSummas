const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const usuarios = require("../controllers/usuarios.controller");

router.use(requireAuth, requireRole(["Administrador"]));

router.get("/", usuarios.listar);
router.post("/", usuarios.crear);
router.put("/:id", usuarios.actualizar);
router.delete("/:id", usuarios.eliminar);

module.exports = router;
