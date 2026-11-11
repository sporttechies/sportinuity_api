// Manager-only request management, mounted at /api/logistics.
// Teams use /api/team/requests instead (scoped to their own team).
const router = require("express").Router();
const controller = require("./logistics.controller");
const { requireRole } = require("../../shared/middleware/auth");

router.use(requireRole("manager"));
router.get("/requests", controller.listRequests);
router.post("/requests", controller.createRequest);
router.get("/requests/:reference", controller.getRequest);
router.patch("/requests/:reference", controller.updateRequest);
router.post("/requests/:reference/status", controller.setStatus);
router.post("/requests/:reference/approve", controller.approveRequest);
router.post("/requests/:reference/reject", controller.rejectRequest);
router.delete("/requests/:reference", controller.deleteRequest);

module.exports = router;
