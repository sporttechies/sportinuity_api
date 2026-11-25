const express = require("express");
const controller = require("./team.controller");
const roster = require("./roster.controller");
const messages = require("../messages/messages.controller");
const transport = require("../transport/transport.team.controller");
const meals = require("../meals/meals.team.controller");
const rooming = require("../rooming/rooming.team.controller");
const invoices = require("../invoices/invoices.controller");
const { requireRole } = require("../../shared/middleware/auth");

// /api/team/*  (team admins only)
const teamRouter = express.Router();
teamRouter.use(requireRole("team_admin"));
teamRouter.get("/profile", controller.getProfile);
teamRouter.patch("/profile", controller.updateProfile);
teamRouter.get("/players", roster.getRoster);
teamRouter.post("/players", roster.addPlayer);
teamRouter.patch("/players/:id", roster.updatePlayer);
teamRouter.delete("/players/:id", roster.removePlayer);
teamRouter.get("/players/:id/document", roster.teamDocument);
teamRouter.post("/roster/submit", roster.submit);
teamRouter.get("/requests", controller.listRequests);
teamRouter.post("/requests", controller.createRequest);
teamRouter.get("/requests/:reference", controller.getRequest);
teamRouter.post("/requests/:reference/cancel", controller.cancelRequest);
teamRouter.get("/requests/:reference/invoices", invoices.teamForRequest);
teamRouter.get("/invoices/:id/pdf", invoices.teamPdf);
teamRouter.get("/requests/:reference/rooming", rooming.get);
teamRouter.put("/requests/:reference/roommates", rooming.saveRoommates);
teamRouter.get("/requests/:reference/rooming/pdf", rooming.pdf);
teamRouter.get("/requests/:reference/meals", meals.get);
teamRouter.get("/requests/:reference/meals/pdf", meals.pdf);
teamRouter.get("/requests/:reference/transport", transport.get);
teamRouter.get("/requests/:reference/transport/pdf", transport.pdf);
teamRouter.get("/messages/unread", messages.teamUnread);
teamRouter.get("/requests/:reference/messages", messages.teamGet);
teamRouter.post("/requests/:reference/messages", messages.teamPost);
teamRouter.get("/draft", controller.getDraft);
teamRouter.put("/draft", controller.saveDraft);
teamRouter.delete("/draft", controller.deleteDraft);

// /api/teams/:id/logo  (public, used by <img> tags)
const publicTeamRouter = express.Router();
publicTeamRouter.get("/:id/logo", controller.getLogo);

module.exports = { teamRouter, publicTeamRouter };
