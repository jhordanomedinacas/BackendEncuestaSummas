const { sql, getPool } = require("../config/db");
const { registrarActividad } = require("../utils/auditoria");

/* POST /api/asignaciones/masiva
   { encuestaId, campaniaId, asesorIds: [1,2,3] }
   Asigna una encuesta a varios asesores de una sola vez (por lote/campaña). */
async function asignarMasivo(req, res, next) {
  try {
    const { encuestaId, campaniaId, asesorIds } = req.body;
    if (!encuestaId || !Array.isArray(asesorIds) || asesorIds.length === 0) {
      return res.status(400).json({ error: "encuestaId y asesorIds[] son obligatorios." });
    }

    const pool = await getPool();
    const resultados = { creadas: 0, yaExistian: 0 };

    const encuestaResult = await pool
      .request()
      .input("EncuestaId", sql.VarChar(20), encuestaId)
      .query(`SELECT Titulo FROM Encuestas WHERE EncuestaId = @EncuestaId`);
    const tituloEncuesta = encuestaResult.recordset[0]?.Titulo || encuestaId;

    for (const asesorId of asesorIds) {
      const existe = await pool
        .request()
        .input("EncuestaId", sql.VarChar(20), encuestaId)
        .input("AsesorId", sql.Int, asesorId)
        .query(`SELECT AsignacionId FROM Asignaciones WHERE EncuestaId = @EncuestaId AND AsesorId = @AsesorId`);

      if (existe.recordset.length > 0) {
        resultados.yaExistian++;
        continue;
      }

      await pool
        .request()
        .input("EncuestaId", sql.VarChar(20), encuestaId)
        .input("AsesorId", sql.Int, asesorId)
        .input("CampaniaId", sql.Int, campaniaId || null)
        .query(`
          INSERT INTO Asignaciones (EncuestaId, AsesorId, CampaniaId)
          VALUES (@EncuestaId, @AsesorId, @CampaniaId)
        `);
      resultados.creadas++;

      const asesorResult = await pool
        .request()
        .input("AsesorId", sql.Int, asesorId)
        .query(`SELECT NombreCompleto, Correo FROM Usuarios WHERE UsuarioId = @AsesorId`);
      const asesor = asesorResult.recordset[0];

      registrarActividad(pool, {
        usuarioId: req.user.usuarioId,
        accion: "ASIGNAR_ENCUESTA",
        entidad: "Asignaciones",
        entidadId: encuestaId,
        detalle: `Asignó la encuesta "${tituloEncuesta}" al encuestador "${asesor?.NombreCompleto || asesorId}" (${asesor?.Correo || "correo no disponible"})`,
        req,
      });
    }

    res.status(201).json(resultados);
  } catch (err) {
    next(err);
  }
}

/* GET /api/asignaciones/mis-encuestas
   Usa el correo del JWT (vista Asesor: lista dinámica tras el 2FA) */
async function misEncuestas(req, res, next) {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input("CorreoAsesor", sql.NVarChar(150), req.user.correo)
      .execute("sp_ObtenerEncuestasAsignadas");
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

/* PUT /api/asignaciones/:id/iniciar
   El asesor abrió el formulario y pasó los hard-constraints (GPS + mic). */
async function iniciar(req, res, next) {
  try {
    const { id } = req.params;
    const pool = await getPool();
    await pool
      .request()
      .input("AsignacionId", sql.BigInt, id)
      .input("AsesorId", sql.Int, req.user.usuarioId)
      .query(`
        UPDATE Asignaciones
        SET Estado = 'EnCurso', FechaInicio = SYSUTCDATETIME()
        WHERE AsignacionId = @AsignacionId AND AsesorId = @AsesorId AND Estado = 'Pendiente'
      `);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/* GET /api/asignaciones/usuario/:usuarioId
   Para el modal de "Editar usuario": qué encuestas tiene asignadas hoy,
   así se pueden pre-marcar las casillas. */
async function obtenerPorUsuario(req, res, next) {
  try {
    const { usuarioId } = req.params;
    const pool = await getPool();
    const result = await pool
      .request()
      .input("AsesorId", sql.Int, usuarioId)
      .query(`
        SELECT AsignacionId, EncuestaId, Estado
        FROM Asignaciones
        WHERE AsesorId = @AsesorId
      `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

/* DELETE /api/asignaciones/:id
   Quita una asignación (al desmarcar la casilla). Solo si sigue
   'Pendiente' — si el encuestador ya la empezó o la envió, no se
   puede quitar sin perder trazabilidad (y el FK de RespuestasEncuesta
   lo impediría de todas formas). */
async function eliminar(req, res, next) {
  try {
    const { id } = req.params;
    const pool = await getPool();

    const actual = await pool
      .request()
      .input("AsignacionId", sql.BigInt, id)
      .query(`SELECT Estado FROM Asignaciones WHERE AsignacionId = @AsignacionId`);

    if (actual.recordset.length === 0) {
      return res.status(404).json({ error: "La asignación no existe." });
    }
    if (actual.recordset[0].Estado !== "Pendiente") {
      return res.status(409).json({
        error: "No se puede quitar: el encuestador ya inició o finalizó esta encuesta.",
      });
    }

    await pool.request().input("AsignacionId", sql.BigInt, id).query(`DELETE FROM Asignaciones WHERE AsignacionId = @AsignacionId`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/* PUT /api/asignaciones/:id/finalizar
   El encuestador termina explícitamente el uso de esta asignación
   (ya entrevistó a todas las personas que necesitaba con este
   formulario). Antes, esto pasaba automático tras cada envío; ahora
   una asignación puede recibir múltiples entrevistas, así que el
   cierre es un paso deliberado. */
async function finalizar(req, res, next) {
  try {
    const { id } = req.params;
    const pool = await getPool();
    await pool
      .request()
      .input("AsignacionId", sql.BigInt, id)
      .input("AsesorId", sql.Int, req.user.usuarioId)
      .query(`
        UPDATE Asignaciones
        SET Estado = 'Finalizada', FechaFin = SYSUTCDATETIME()
        WHERE AsignacionId = @AsignacionId AND AsesorId = @AsesorId AND Estado IN ('Pendiente','EnCurso')
      `);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/* GET /api/asignaciones/pendientes
   Todas las asignaciones aún no finalizadas, con el asesor y la
   encuesta — para cuando el admin hace clic en "Pendientes" desde
   el dashboard y quiere saber a quién le toca encuestar qué. */
async function pendientesGlobal(req, res, next) {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        a.AsignacionId, a.Estado, a.FechaAsignacion, a.FechaInicio,
        e.EncuestaId, e.Titulo AS TituloEncuesta,
        u.UsuarioId AS AsesorId, u.NombreCompleto AS Asesor, u.Correo AS CorreoAsesor
      FROM Asignaciones a
      JOIN Encuestas e ON e.EncuestaId = a.EncuestaId
      JOIN Usuarios u ON u.UsuarioId = a.AsesorId
      WHERE a.Estado IN ('Pendiente','EnCurso')
        AND NOT EXISTS (SELECT 1 FROM RespuestasEncuesta r WHERE r.AsignacionId = a.AsignacionId)
      ORDER BY a.FechaAsignacion DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    next(err);
  }
}

module.exports = { asignarMasivo, misEncuestas, iniciar, obtenerPorUsuario, eliminar, finalizar, pendientesGlobal };
