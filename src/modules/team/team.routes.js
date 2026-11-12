const express = require("express");
const controller = require("./team.controller");
const invoices = require("../invoices/invoices.controller");
const { requireRole } = require("../../shared/middleware/auth");

// /api/team/*  (team admins only)
const teamRouter = express.Router();
teamRouter.use(requireRole("team_admin"));
teamRouter.get("/profile", controller.getProfile);
teamRouter.patch("/profile", controller.updateProfile);
teamRouter.get("/requests", controller.listRequests);
teamRouter.post("/requests", controller.createRequest);
teamRouter.get("/requests/:reference", controller.getRequest);
teamRouter.post("/requests/:reference/cancel", controller.cancelRequest);
teamRouter.get("/requests/:reference/invoices", invoices.teamForRequest);
teamRouter.get("/invoices/:id/pdf", invoices.teamPdf);
teamRouter.get("/draft", controller.getDraft);
teamRouter.put("/draft", controller.saveDraft);
teamRouter.delete("/draft", controller.deleteDraft);

// /api/teams/:id/logo  (public, used by <img> tags)
const publicTeamRouter = express.Router();
publicTeamRouter.get("/:id/logo", controller.getLogo);

module.exports = { teamRouter, publicTeamRouter };
