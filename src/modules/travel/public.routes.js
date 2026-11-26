// Public Sports Travel API, mounted at /api/public/travel. No login; booking and lookup are rate limited.
const router = require("express").Router();
const c = require("./public.controller");
const { rateLimit } = require("../../shared/middleware/rate-limit");

const bookLimit = rateLimit({ name: "travel-book", windowMs: 60 * 60 * 1000, max: 10, message: "Too many booking attempts. Please try again in a while." });
const lookupLimit = rateLimit({ name: "travel-lookup", windowMs: 10 * 60 * 1000, max: 20, message: "Too many lookups. Please wait a few minutes and try again." });

router.get("/trips", c.listTrips);
router.get("/trips/:slug", c.getTrip);
router.post("/trips/:slug/bookings", bookLimit, c.book);
router.post("/bookings/lookup", lookupLimit, c.lookup);
router.post("/bookings/lookup/invoice.pdf", lookupLimit, c.lookupInvoice);

module.exports = router;
