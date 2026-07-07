const sql = require("mssql");

/**
 * Pool de conexión único y reutilizable (mssql recomienda NO abrir
 * una conexión nueva por request — es costoso).
 */
let poolPromise = null;

function getPool() {
  if (!poolPromise) {
    const config = {
      server: process.env.DB_SERVER,
      port: Number(process.env.DB_PORT || 1433),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      options: {
        encrypt: process.env.DB_ENCRYPT === "true",
        trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === "true",
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
      },
    };

    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .then((pool) => {
        console.log("[db] Conectado a SQL Server:", process.env.DB_NAME);
        return pool;
      })
      .catch((err) => {
        poolPromise = null; // permite reintentar en el próximo request
        console.error("[db] Error de conexión:", err.message);
        throw err;
      });
  }
  return poolPromise;
}

module.exports = { sql, getPool };
