require("dotenv").config();
require("./config/db");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const authRoutes = require("./modules/auth/auth.routes");
const logisticsRoutes = require("./modules/logistics/logistics.routes");
const { errorHandler } = require("./shared/middleware/error-handler");
const { checkDatabaseConnection, closeDatabase } = require("./config/db");

const app = express();
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") || [],
    credentials: false,
  }),
);
app.use(express.json());
app.get("/api/health", (_req, res) =>
  res.json({ service: "sportinuity-api", status: "ok" }),
);
app.use("/api/auth", authRoutes);
app.use("/api/logistics", logisticsRoutes);
app.use(errorHandler);

if (require.main === module) {
  const port = process.env.PORT || 4000;
  app.listen(port, async () => {
    console.log(`[api] Sportinuity API listening on port ${port}`);
    try {
      const database = await checkDatabaseConnection();
      console.log(
        `[db] connected to ${database.database} at ${new Date(database.server_time).toISOString()}`,
      );
    } catch (error) {
      console.error("[db] connection failed:", error.message);
      process.exitCode = 1;
    }
  });
  const shutdown = async (signal) => {
    console.log(`[api] ${signal} received, shutting down`);
    await closeDatabase();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
module.exports = app;
