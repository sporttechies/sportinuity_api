// Manager-only invoice routes, mounted at /api/invoices.
const router = require("express").Router();
const c = require("./invoices.controller");
const { requireRole } = require("../../shared/middleware/auth");

router.use(requireRole("manager"));
router.get("/settings", c.getSettings);
router.put("/settings", c.putSettings);
router.get("/for-request/:reference", c.forRequest);
router.get("/", c.list);
router.post("/", c.create);
router.get("/:id", c.get);
router.patch("/:id", c.update);
router.delete("/:id", c.remove);
router.get("/:id/pdf", c.pdf);
router.post("/:id/issue", c.issue);
router.post("/:id/resend", c.resend);
router.post("/:id/paid", c.paid);
router.post("/:id/unpaid", c.unpaid);
router.post("/:id/void", c.void);

module.exports = router;
