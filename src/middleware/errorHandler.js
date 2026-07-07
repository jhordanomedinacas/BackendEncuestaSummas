/* eslint-disable no-unused-vars */
function errorHandler(err, req, res, next) {
  console.error("[error]", err);

  if (err.name === "RequestError") {
    // Errores lanzados por RAISERROR en los procedimientos de SQL Server
    return res.status(400).json({ error: err.message });
  }

  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Error interno del servidor." });
}

module.exports = { errorHandler };
