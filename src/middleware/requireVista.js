/**
 * Protege rutas según la "vista" del panel a la que pertenecen
 * (dashboard, encuestas, encuestados). El Administrador siempre pasa.
 * El Supervisor necesita tener esa vista en su lista de permisos
 * (asignada por el admin al crearlo/editarlo). Cualquier otro rol
 * no debería llegar aquí (ya filtrado por requireRole antes).
 */
function requireVista(vista) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "No autenticado." });
    }
    if (req.user.rol === "Administrador") {
      return next();
    }
    const vistas = req.user.vistasPermitidas || [];
    if (!vistas.includes(vista)) {
      return res.status(403).json({ error: "No tienes permiso para ver esta sección." });
    }
    next();
  };
}

module.exports = { requireVista };
