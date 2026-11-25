// Manager-only staff assignments, mounted at /api/assignments.
const router = require("express").Router();
const c = require("./assignments.controller");
const { requireRole } = require("../../shared/middleware/auth");

router.use(requireRole("manager"));
router.get("/staff", c.staff);
router.delete("/:id", c.unassign);
router.get("/for/:reference", c.list);
router.post("/for/:reference", c.assign);

module.exports = router;
