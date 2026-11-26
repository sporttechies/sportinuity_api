// Manager-only: dashboard, teams and own profile. Mounted at /api/manager.
const router = require("express").Router();
const controller = require("./manager.controller");
const mywork = require("./mywork.controller");
const roster = require("../team/roster.controller");
const editions = require("../editions/editions.controller");
const { requireRole } = require("../../shared/middleware/auth");

router.use(requireRole("manager"));
router.get("/dashboard", controller.dashboard);
router.get("/my-work", mywork.myWork);
router.get("/teams", controller.listTeams);
router.get("/teams/:id", controller.getTeam);
router.patch("/teams/:id", controller.updateTeam);
router.post("/teams/:id/status", controller.setTeamStatus);
router.delete("/teams/:id", controller.deleteTeam);
router.get("/teams/:id/players", roster.managerRoster);
router.get("/teams/:id/players/:playerId/document", roster.managerDocument);
router.post("/teams/:id/roster/review", roster.reviewRoster);
router.get("/editions", editions.list);
router.post("/editions", editions.create);
router.patch("/editions/:id", editions.update);
router.delete("/editions/:id", editions.remove);
router.patch("/me", controller.updateMe);

module.exports = router;
