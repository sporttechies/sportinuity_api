// Manager-only supplier directory, mounted at /api/suppliers.
const router = require("express").Router();
const c = require("./suppliers.controller");
const { requireRole } = require("../../shared/middleware/auth");

router.use(requireRole("manager"));
router.get("/", c.list);
router.post("/", c.create);
router.get("/:id", c.get);
router.patch("/:id", c.update);
router.delete("/:id", c.remove);

module.exports = router;
