// Public (no login) Sports Travel API: browse trips, book, and look a booking up again.
const { z } = require("zod");
const { query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");
const notify = require("../../shared/mail/notify");
const bookings = require("./bookings.controller");

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};
const hhmm = (v) => (v ? String(v).slice(0, 5) : null);
const today = () => new Date().toISOString().slice(0, 10);

const SELECT = `p.id, p.slug, p.title, p.event_name, p.destination, p.country, p.start_date::text AS start_date, p.end_date::text AS end_date,
  p.summary, p.description, p.audiences, p.price_cents, p.single_supplement_cents, p.currency, p.capacity, p.status,
  p.booking_deadline::text AS booking_deadline, p.cover_image_url, p.inclusions, p.exclusions,
  COALESCE((SELECT sum(b.seats) FROM travel_bookings b WHERE b.package_id = p.id AND b.status IN ('pending','confirmed','completed')), 0)::int AS seats_taken`;

function serializeTrip(r) {
  const left = r.capacity == null ? null : Math.max(r.capacity - r.seats_taken, 0);
  const t = today();
  return {
    slug: r.slug, title: r.title, eventName: r.event_name, destination: r.destination, country: r.country,
    startDate: r.start_date, endDate: r.end_date, summary: r.summary, audiences: r.audiences,
    priceCents: r.price_cents, singleSupplementCents: r.single_supplement_cents, currency: String(r.currency).trim(),
    bookingDeadline: r.booking_deadline, coverImageUrl: r.cover_image_url, seatsLeft: left,
    bookingOpen: r.status === "published" && r.end_date >= t && (!r.booking_deadline || r.booking_deadline >= t) && (left === null || left > 0),
  };
}

// Trips people can still see: published, or closed but not yet over. Draft/archived never appear.
const VISIBLE = `(p.status = 'published' OR p.status = 'closed') AND p.end_date >= CURRENT_DATE`;

const listTrips = wrap(async (req, res) => {
  const where = [VISIBLE];
  const vals = [];
  const audience = String(req.query.audience || "");
  if (["fans", "groups", "organisers"].includes(audience)) { vals.push(audience); where.push(`$${vals.length} = ANY(p.audiences)`); }
  if (req.query.q) {
    vals.push(`%${String(req.query.q).trim().slice(0, 80).replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`(p.title ILIKE $${vals.length} OR p.destination ILIKE $${vals.length} OR p.event_name ILIKE $${vals.length})`);
  }
  const { rows } = await query(`SELECT ${SELECT} FROM travel_packages p WHERE ${where.join(" AND ")} ORDER BY p.start_date, p.title LIMIT 100`, vals);
  res.json({ data: rows.map(serializeTrip) });
});

const getTrip = wrap(async (req, res) => {
  const slug = z.string().trim().min(1).max(120).parse(req.params.slug);
  const { rows } = await query(`SELECT ${SELECT} FROM travel_packages p WHERE p.slug = $1 AND ${VISIBLE}`, [slug]);
  if (!rows.length) throw new HttpError(404, "Trip not found");
  const items = await query(
    `SELECT day_number, kind, title, details, start_time FROM travel_itinerary_items WHERE package_id = $1 ORDER BY day_number, start_time NULLS LAST, sort, created_at`,
    [rows[0].id],
  );
  res.json({
    data: {
      ...serializeTrip(rows[0]), description: rows[0].description, inclusions: rows[0].inclusions, exclusions: rows[0].exclusions,
      itinerary: items.rows.map((i) => ({ dayNumber: i.day_number, kind: i.kind, title: i.title, details: i.details, startTime: hhmm(i.start_time) })),
    },
  });
});

/** Customer-facing view of a booking: no internal notes, no ID numbers. */
function publicBooking(b) {
  return {
    reference: b.reference, status: b.status, customerType: b.customerType, package: { ...b.package },
    contactName: b.contactName, contactEmail: b.contactEmail, contactPhone: b.contactPhone, organisation: b.organisation,
    currency: b.currency, seats: b.seats, singleRooms: b.singleRooms, totalCents: b.totalCents, notes: b.notes, createdAt: b.createdAt,
    cancelReason: b.cancelReason,
    invoice: b.invoice ? { number: b.invoice.number, status: b.invoice.status, issuedAt: b.invoice.issuedAt, dueDate: b.invoice.dueDate, paidAt: b.invoice.paidAt } : null,
    travellers: (b.travellers ?? []).map((t) => ({ firstName: t.firstName, lastName: t.lastName, category: t.category, singleRoom: t.singleRoom, dietary: t.dietary })),
  };
}

const book = wrap(async (req, res) => {
  const slug = z.string().trim().min(1).max(120).parse(req.params.slug);
  const { rows } = await query(`SELECT id FROM travel_packages WHERE slug = $1`, [slug]);
  if (!rows.length) throw new HttpError(404, "Trip not found");
  const body = bookings.createBody.parse(req.body);
  const id = await bookings.createBooking(rows[0].id, body, { online: true });
  const booking = await bookings.load(id);
  notify.travelBookingCreated(booking);
  res.status(201).json({ data: { reference: booking.reference, totalCents: booking.totalCents, currency: booking.currency, seats: booking.seats } });
});

// Guests prove it's their booking with the reference plus the email or phone used.
const lookupBody = z.object({
  reference: z.string().trim().toUpperCase().regex(/^TB-\d{1,10}$/),
  contact: z.string().trim().min(3).max(200),
});
const digits = (v) => String(v || "").replace(/\D/g, "");
async function findOwned(body) {
  const { reference, contact } = lookupBody.parse(body);
  const { rows } = await query(`SELECT id, contact_email, contact_phone FROM travel_bookings WHERE reference = $1`, [reference]);
  const r = rows[0];
  const email = contact.toLowerCase();
  const phone = digits(contact);
  const ok = r && ((r.contact_email && r.contact_email.toLowerCase() === email) || (phone.length >= 6 && digits(r.contact_phone) === phone));
  if (!ok) throw new HttpError(404, "We couldn't find a booking with those details");
  return r.id;
}

const lookup = wrap(async (req, res) => {
  res.json({ data: publicBooking(await bookings.load(await findOwned(req.body))) });
});
const lookupInvoice = wrap(async (req, res) => {
  const id = await findOwned(req.body);
  const b = await bookings.load(id);
  if (!b.invoice) throw new HttpError(404, "The invoice hasn't been issued yet");
  bookings.sendPdf(res, await bookings.buildInvoicePdf(id));
});

module.exports = { listTrips, getTrip, book, lookup, lookupInvoice };
