// Manager-only rooming lists, mounted at /api/rooming.
const router = require("express").Router();
const c = require("./rooming.controller");
const { requireRole } = require("../../shared/middleware/auth");

router.use(requireRole("manager"));
router.patch("/rooms/:id", c.updateRoom);
router.delete("/rooms/:id", c.deleteRoom);
router.put("/rooms/:id/occupants", c.setOccupants);
router.get("/:reference", c.get);
router.get("/:reference/pdf", c.pdf);
router.patch("/:reference", c.updateNotes);
router.post("/:reference/rooms", c.createRooms);
router.post("/:reference/suggest", c.suggest);
router.post("/:reference/clear", c.clear);
router.post("/:reference/finalize", c.finalize);
router.post("/:reference/reopen", c.reopen);

module.exports = router;
