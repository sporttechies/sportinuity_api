// Manager-only transport planning, mounted at /api/transport.
const router = require("express").Router();
const c = require("./transport.controller");
const { requireRole } = require("../../shared/middleware/auth");

router.use(requireRole("manager"));
router.patch("/legs/:id", c.update);
router.delete("/legs/:id", c.remove);
router.put("/legs/:id/passengers", c.setPassengers);
router.get("/:reference", c.get);
router.get("/:reference/pdf", c.pdf);
router.post("/:reference/legs", c.create);
router.post("/:reference/confirm", c.confirmAll);

module.exports = router;
