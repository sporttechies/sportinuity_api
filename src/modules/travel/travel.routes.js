// Manager-only Sports Travel management, mounted at /api/travel.
const router = require("express").Router();
const packages = require("./packages.controller");
const bookings = require("./bookings.controller");
const { requireRole } = require("../../shared/middleware/auth");

router.use(requireRole("manager"));
router.get("/packages", packages.list);
router.post("/packages", packages.create);
router.patch("/items/:itemId", packages.updateItem);
router.delete("/items/:itemId", packages.removeItem);
router.get("/packages/:id", packages.get);
router.patch("/packages/:id", packages.update);
router.delete("/packages/:id", packages.remove);
router.post("/packages/:id/status", packages.setStatus);
router.post("/packages/:id/duplicate", packages.duplicate);
router.post("/packages/:id/items", packages.addItem);

router.post("/packages/:id/bookings", bookings.create);
router.get("/bookings", bookings.list);
router.get("/bookings/:id", bookings.get);
router.patch("/bookings/:id", bookings.update);
router.put("/bookings/:id/travellers", bookings.setTravellers);
router.post("/bookings/:id/status", bookings.setStatus);
router.post("/bookings/:id/invoice", bookings.issueInvoice);
router.post("/bookings/:id/paid", bookings.paid);
router.post("/bookings/:id/unpaid", bookings.unpaid);
router.get("/bookings/:id/invoice.pdf", bookings.invoicePdf);

module.exports = router;
