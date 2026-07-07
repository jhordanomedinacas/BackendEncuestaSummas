const { sql, getPool } = require("../config/db");
const { registrarActividad } = require("../utils/auditoria");

/* GET /api/campanias */
async function listar(req, res, next) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        c.CampaniaId, c.CodigoCampania, c.Nombre, c.FechaInicio, c.FechaFin, c.Estado, c.FechaCreacion,
        (SELECT COUNT(*) FROM Encuestas e WHERE e.CampaniaId = c.CampaniaId) AS TotalEncuestas
      FROM Campanias c
      ORDER BY c.FechaCreacion DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

/* POST /api/campanias  { codigoCampania, nombre, fechaInicio } */
async function crear(req, res, next) {
  try {
    const { codigoCampania, nombre, fechaInicio } = req.body;
    if (!codigoCampania || !nombre) {
      return res.status(400).json({ error: "Código y nombre de campaña son obligatorios." });
    }

    const pool = await getPool();

    const existe = await pool
      .request()
      .input("CodigoCampania", sql.NVarChar(30), codigoCampania)
      .query(`SELECT CampaniaId FROM Campanias WHERE CodigoCampania = @CodigoCampania`);
    if (existe.recordset.length > 0) {
      return res.status(409).json({ error: "Ya existe una campaña con ese código." });
    }

    const result = await pool
      .request()
      .input("CodigoCampania", sql.NVarChar(30), codigoCampania)
      .input("Nombre", sql.NVarChar(150), nombre)
      .input("FechaInicio", sql.Date, fechaInicio || new Date())
      .input("CreadaPor", sql.Int, req.user.usuarioId)
      .query(`
        INSERT INTO Campanias (CodigoCampania, Nombre, FechaInicio, Estado, CreadaPor)
        OUTPUT INSERTED.CampaniaId
        VALUES (@CodigoCampania, @Nombre, @FechaInicio, 'Activa', @CreadaPor)
      `);

    res.status(201).json({ campaniaId: result.recordset[0].CampaniaId });

    registrarActividad(pool, {
      usuarioId: req.user.usuarioId,
      accion: "CREAR_CAMPANIA",
      entidad: "Campanias",
      entidadId: result.recordset[0].CampaniaId,
      detalle: `Creó la campaña "${nombre}" (${codigoCampania})`,
      req,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { listar, crear };
