const { Pool } = require("pg");

if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL is required to start the API");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : undefined,
});
pool.on("error", (error) =>
  console.error("[db] unexpected idle client error", error),
);

async function query(text, values) {
  return pool.query(text, values);
}
async function checkDatabaseConnection() {
  const result = await pool.query(
    "SELECT current_database() AS database, NOW() AS server_time",
  );
  return result.rows[0];
}
async function closeDatabase() {
  await pool.end();
}
module.exports = { pool, query, checkDatabaseConnection, closeDatabase };
