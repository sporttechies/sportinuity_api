const router = require("express").Router();
const {
  loginTeam,
  loginManager,
  registerTeam,
  me,
  changePassword,
} = require("./auth.controller");
const { requireAuth } = require("../../shared/middleware/auth");

router.post("/login", loginManager);
router.post("/manager/login", loginManager);
router.post("/team/register", registerTeam);
router.post("/team/login", loginTeam);
router.get("/me", requireAuth, me);
router.get("/team/me", requireAuth, me);
router.post("/password", requireAuth, changePassword);

module.exports = router;
