// Manager-only: dashboard, teams and own profile. Mounted at /api/manager.
const router = require("express").Router();
const controller = require("./manager.controller");
const { requireRole } = require("../../shared/middleware/auth");

router.use(requireRole("manager"));
router.get("/dashboard", controller.dashboard);
router.get("/teams", controller.listTeams);
router.get("/teams/:id", controller.getTeam);
router.patch("/teams/:id", controller.updateTeam);
router.post("/teams/:id/status", controller.setTeamStatus);
router.delete("/teams/:id", controller.deleteTeam);
router.patch("/me", controller.updateMe);

module.exports = router;
