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
async function subirEvidenciaLocal(respuestaEncuestaId, buffer, nombreOriginal, contentType, req) {
  const carpeta = path.join(UPLOADS_DIR, respuestaEncuestaId);
  asegurarCarpeta(carpeta);

  const extension = (nombreOriginal.split(".").pop() || "bin").toLowerCase();
  const nombreArchivo = `${Date.now()}.${extension}`;
  const rutaCompleta = path.join(carpeta, nombreArchivo);

  fs.writeFileSync(rutaCompleta, buffer);

  // blobPath guarda la ruta relativa — la misma "forma" que usaríamos con Azure
  const blobPath = `${respuestaEncuestaId}/${nombreArchivo}`;
  return { blobPath, url: urlPublicaLocal(blobPath, req) };
}

/**
 * Arma la URL pública del archivo. Si PUBLIC_BACKEND_URL está seteada
 * (recomendado en producción), se usa esa. Si no, y se pasó el `req`
 * de la petición actual, se auto-detecta del propio host (funciona
 * "solo" en Azure App Service sin tener que configurar nada a mano).
 * Como último recurso, cae a localhost (solo tiene sentido en desarrollo).
 */
function urlPublicaLocal(blobPath, req) {
  let base = process.env.PUBLIC_BACKEND_URL;
  if (!base && req) {
    base = `${req.protocol}://${req.get("host")}`;
  }
  if (!base) {
    base = `http://localhost:${process.env.PORT || 4000}`;
  }
  return `${base}/uploads/evidencias/${blobPath}`;
}

module.exports = { subirEvidenciaLocal, urlPublicaLocal, UPLOADS_DIR };
