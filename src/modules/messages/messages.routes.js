// Manager side of request messages, mounted at /api/messages.
const router = require("express").Router();
const c = require("./messages.controller");
const { requireRole } = require("../../shared/middleware/auth");

router.use(requireRole("manager"));
router.get("/unread", c.managerUnread);
router.get("/:reference", c.managerGet);
router.post("/:reference", c.managerPost);

module.exports = router;
