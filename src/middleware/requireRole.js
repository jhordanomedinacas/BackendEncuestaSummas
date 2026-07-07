/**
 * Restringe una ruta a ciertos roles.
 * Uso: router.get("/usuarios", requireAuth, requireRole(["Administrador"]), handler)
 */
function requireRole(rolesPermitidos = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: "No autenticado." });
    }
    if (!rolesPermitidos.includes(req.user.rol)) {
      return res.status(403).json({ error: "No tienes permisos para esta acción." });
    }
    next();
  };
}

module.exports = { requireRole };
