const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const path = require("path");

const authRoutes = require("./routes/auth.routes");
const usuariosRoutes = require("./routes/usuarios.routes");
const encuestasRoutes = require("./routes/encuestas.routes");
const asignacionesRoutes = require("./routes/asignaciones.routes");
const respuestasRoutes = require("./routes/respuestas.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const evidenciasRoutes = require("./routes/evidencias.routes");
const campaniasRoutes = require("./routes/campanias.routes");
const actividadRoutes = require("./routes/actividad.routes");
const { errorHandler } = require("./middleware/errorHandler");

const app = express();

app.use(helmet()); // política completa de seguridad para toda la API
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(express.json({ limit: "2mb" }));

// Audios/adjuntos guardados en disco local (fallback cuando Azure no está configurado).
// Solo AQUÍ se relaja CORP (necesario para que <audio>/<img> del frontend, en
// otro origen, puedan cargarlos) — el resto de la API mantiene la política estricta.
app.use(
  "/uploads",
  helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }),
  express.static(path.join(__dirname, "..", "uploads"))
);

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/usuarios", usuariosRoutes);
app.use("/api/encuestas", encuestasRoutes);
app.use("/api/asignaciones", asignacionesRoutes);
app.use("/api/respuestas", respuestasRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/evidencias", evidenciasRoutes);
app.use("/api/campanias", campaniasRoutes);
app.use("/api/actividad", actividadRoutes);

app.use((req, res) => res.status(404).json({ error: "Ruta no encontrada." }));
app.use(errorHandler);

module.exports = app;
