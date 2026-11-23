// Manager-only meal schedule, mounted at /api/meals.
const router = require("express").Router();
const c = require("./meals.controller");
const { requireRole } = require("../../shared/middleware/auth");

router.use(requireRole("manager"));
router.patch("/meals/:id", c.update);
router.delete("/meals/:id", c.remove);
router.get("/:reference", c.get);
router.get("/:reference/pdf", c.pdf);
router.post("/:reference/meals", c.create);
router.post("/:reference/generate", c.generate);
router.post("/:reference/confirm", c.confirmAll);

module.exports = router;
