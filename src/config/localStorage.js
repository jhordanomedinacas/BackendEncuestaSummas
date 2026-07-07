const fs = require("fs");
const path = require("path");

const UPLOADS_DIR = path.join(__dirname, "..", "..", "uploads", "evidencias");

function asegurarCarpeta(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Guarda el archivo en disco, organizado por carpeta = ID de la respuesta
 * (mismo criterio de "etiquetado" que usaríamos en Azure).
 */
async function subirEvidenciaLocal(respuestaEncuestaId, buffer, nombreOriginal, contentType) {
  const carpeta = path.join(UPLOADS_DIR, respuestaEncuestaId);
  asegurarCarpeta(carpeta);

  const extension = (nombreOriginal.split(".").pop() || "bin").toLowerCase();
  const nombreArchivo = `${Date.now()}.${extension}`;
  const rutaCompleta = path.join(carpeta, nombreArchivo);

  fs.writeFileSync(rutaCompleta, buffer);

  // blobPath guarda la ruta relativa — la misma "forma" que usaríamos con Azure
  const blobPath = `${respuestaEncuestaId}/${nombreArchivo}`;
  return { blobPath, url: urlPublicaLocal(blobPath) };
}

function urlPublicaLocal(blobPath) {
  const base = process.env.PUBLIC_BACKEND_URL || `http://localhost:${process.env.PORT || 4000}`;
  return `${base}/uploads/evidencias/${blobPath}`;
}

module.exports = { subirEvidenciaLocal, urlPublicaLocal, UPLOADS_DIR };
