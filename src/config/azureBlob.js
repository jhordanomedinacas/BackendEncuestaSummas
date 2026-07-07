const { BlobServiceClient } = require("@azure/storage-blob");
const { subirEvidenciaLocal, urlPublicaLocal } = require("./localStorage");

let containerClientPromise = null;

/**
 * Detecta si hay una cadena de conexión de Azure real configurada.
 * El .env.example trae un placeholder ("TU_CUENTA") — mientras esté
 * así, usamos almacenamiento local automáticamente.
 */
function azureConfigurado() {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  return !!cs && !cs.includes("TU_CUENTA") && !cs.includes("TU_KEY");
}

function getContainerClient() {
  if (!containerClientPromise) {
    const connStr = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const containerName = process.env.AZURE_CONTAINER_EVIDENCIAS || "evidencias-audio";
    const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
    const containerClient = blobServiceClient.getContainerClient(containerName);

    containerClientPromise = containerClient
      .createIfNotExists({ access: "container" === "public" ? "container" : undefined })
      .then(() => containerClient);
  }
  return containerClientPromise;
}

/**
 * Sube un archivo (audio de control o adjunto) etiquetado con el ID
 * de la respuesta de encuesta. Usa Azure Blob si está configurado;
 * si no, cae automáticamente a disco local (backend/uploads/).
 *
 * @param {string} respuestaEncuestaId
 * @param {Buffer} buffer
 * @param {string} nombreOriginal
 * @param {string} contentType
 * @returns {Promise<{blobPath: string, url: string}>}
 */
async function subirEvidencia(respuestaEncuestaId, buffer, nombreOriginal, contentType) {
  if (!azureConfigurado()) {
    console.log(`[evidencias] Azure no configurado — guardando "${nombreOriginal}" en disco local.`);
    return subirEvidenciaLocal(respuestaEncuestaId, buffer, nombreOriginal, contentType);
  }

  const containerClient = await getContainerClient();
  const extension = (nombreOriginal.split(".").pop() || "bin").toLowerCase();
  const blobPath = `${respuestaEncuestaId}/${Date.now()}.${extension}`;
  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);

  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: contentType },
    metadata: { respuestaEncuestaId, nombreOriginal },
  });

  return { blobPath, url: blockBlobClient.url };
}

/**
 * Genera una URL para streaming/descarga directa (para el Repositorio
 * de Evidencias del admin). En producción con Azure real, usar un SAS
 * token con expiración corta en vez de exponer la URL cruda.
 */
async function obtenerUrlEvidencia(blobPath) {
  if (!azureConfigurado()) {
    return urlPublicaLocal(blobPath);
  }

  const containerClient = await getContainerClient();
  const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
  return blockBlobClient.url;
}

module.exports = { subirEvidencia, obtenerUrlEvidencia, azureConfigurado };
