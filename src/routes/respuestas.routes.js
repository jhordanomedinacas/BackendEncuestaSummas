const express = require("express");
const multer = require("multer");
const router = express.Router();
const { requireAuth } = require("../middleware/auth");
const respuestas = require("../controllers/respuestas.controller");

// Audio en memoria (se transfiere a Azure Blob o a disco local, sin quedarse en disco temporal)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB — para grabaciones largas, "dure lo que dure"
});

router.post(
  "/",
  requireAuth,
  upload.fields([
    { name: "audio", maxCount: 1 },
    { name: "archivos", maxCount: 10 },
  ]),
  respuestas.registrar
);

module.exports = router;
