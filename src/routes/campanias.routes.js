const express = require("express");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const { requireRole } = require("../middleware/requireRole");
const campanias = require("../controllers/campanias.controller");

router.use(requireAuth, requireRole(["Administrador", "Supervisor"]));

router.get("/", campanias.listar);
router.post("/", campanias.crear);

module.exports = router;
