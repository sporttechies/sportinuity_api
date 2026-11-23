// Manager-only quotations, mounted at /api/quotations.
const router = require("express").Router();
const c = require("./quotations.controller");
const { requireRole } = require("../../shared/middleware/auth");

router.use(requireRole("manager"));
router.get("/for-request/:reference", c.forRequest);
router.post("/", c.create);
router.patch("/:id", c.update);
router.post("/:id/accept", c.accept);
router.post("/:id/reject", c.reject);
router.post("/:id/reopen", c.reopen);
router.delete("/:id", c.remove);

module.exports = router;
