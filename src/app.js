require("dotenv").config();
require("./config/db");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const authRoutes = require("./modules/auth/auth.routes");
const logisticsRoutes = require("./modules/logistics/logistics.routes");
const managerRoutes = require("./modules/manager/manager.routes");
const { teamRouter, publicTeamRouter } = require("./modules/team/team.routes");
const { errorHandler } = require("./shared/middleware/error-handler");
const { checkDatabaseConnection, closeDatabase } = require("./config/db");

const app = express();
// Render sits behind one proxy; this makes req.ip the real client (used by the rate limiter).
app.set("trust proxy", 1);
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") || [],
    credentials: false,
  }),
);
// 1 MB: team logos arrive as base64 (the frontends shrink them to ~256px first).
app.use(express.json({ limit: "3mb" }));
app.get("/api/health", (_req, res) =>
  res.json({ service: "sportinuity-api", status: "ok" }),
);
app.use("/api/auth", authRoutes);
app.use("/api/team", teamRouter);
app.use("/api/teams", publicTeamRouter);
app.get(
  "/api/registration-options",
  require("./modules/editions/editions.controller").options,
);
app.use("/api/logistics", logisticsRoutes);
app.use("/api/manager", managerRoutes);
app.use("/api/invoices", require("./modules/invoices/invoices.routes"));
app.use("/api/suppliers", require("./modules/suppliers/suppliers.routes"));
app.use("/api/quotations", require("./modules/suppliers/quotations.routes"));
app.use("/api/rooming", require("./modules/rooming/rooming.routes"));
app.use("/api/meals", require("./modules/meals/meals.routes"));
app.use("/api/transport", require("./modules/transport/transport.routes"));
app.use("/api/messages", require("./modules/messages/messages.routes"));
app.use(
  "/api/assignments",
  require("./modules/assignments/assignments.routes"),
);
app.use("/api/travel", require("./modules/travel/travel.routes"));
app.use("/api/public/travel", require("./modules/travel/public.routes"));
app.use((_req, res) => res.status(404).json({ message: "Not found" }));
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
