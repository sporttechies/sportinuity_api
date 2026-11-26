// Sports Travel bookings (manager side): create for a customer, edit, travellers, status, invoice.
const { z } = require("zod");
const { pool, query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");
const invoiceRepo = require("../invoices/invoices.repository");
const notify = require("../../shared/mail/notify");
const { renderInvoice } = require("../invoices/invoices.pdf");

const blank = (v) => (v === "" ? null : v);
const opt = (max) => z.preprocess(blank, z.string().trim().max(max).nullable().optional());
const HELD = ["pending", "confirmed", "completed"]; // statuses that hold seats

const traveller = z.object({
  firstName: z.string().trim().min(1, "Enter every traveller's first name").max(80),
  lastName: z.string().trim().min(1, "Enter every traveller's last name").max(80),
  category: z.enum(["adult", "child"]).optional(),
  documentNumber: opt(60),
  dietary: opt(200),
  singleRoom: z.boolean().optional(),
});
const travellers = z.array(traveller).min(1, "Add at least one traveller").max(200);
const contactFields = {
  customerType: z.enum(["fan", "group", "organiser"], { error: "Choose the customer type" }),
  contactName: z.string().trim().min(2, "Enter the contact name").max(120),
  contactEmail: z.preprocess(blank, z.string().trim().toLowerCase().email("Enter a valid email").max(200).nullable().optional()),
  contactPhone: opt(40),
  organisation: opt(160),
  notes: opt(2000),
};
const needs = (b) => {
  if (!b.contactEmail && !b.contactPhone) throw new HttpError(400, "Enter an email or a phone number for the customer");
  if (b.customerType !== "fan" && !b.organisation) throw new HttpError(400, "Enter the group or organisation name");
};
const createBody = z.object({ ...contactFields, travellers });
const patchBody = z.object({
  ...Object.fromEntries(Object.entries(contactFields).map(([k, v]) => [k, v.optional()])),
  managerNotes: opt(2000),
});

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};
const uuid = (v, msg = "Booking not found") => z.uuid({ error: msg }).parse(v);

const SELECT = `b.*, p.title AS package_title, p.slug AS package_slug, p.destination AS package_destination,
  p.event_name AS package_event, p.start_date::text AS package_start, p.end_date::text AS package_end,
  b.invoice_due_date::text AS due_date`;
const FROM = `FROM travel_bookings b JOIN travel_packages p ON p.id = b.package_id`;

const invoiceOf = (r) =>
  r.invoice_number
    ? {
        number: r.invoice_number,
        status: r.invoice_voided_at ? "void" : r.invoice_paid_at ? "paid" : "issued",
        issuedAt: r.invoice_issued_at, dueDate: r.due_date, paidAt: r.invoice_paid_at, voidedAt: r.invoice_voided_at,
      }
    : null;

const serialize = (r, extra = {}) => ({
  id: r.id, reference: r.reference, status: r.status, customerType: r.customer_type,
  packageId: r.package_id,
  package: { title: r.package_title, slug: r.package_slug, destination: r.package_destination, eventName: r.package_event, startDate: r.package_start, endDate: r.package_end },
  contactName: r.contact_name, contactEmail: r.contact_email, contactPhone: r.contact_phone, organisation: r.organisation,
  currency: String(r.currency).trim(), unitPriceCents: r.unit_price_cents, singleSupplementCents: r.single_supplement_cents,
  seats: r.seats, singleRooms: r.single_rooms, totalCents: Number(r.total_cents),
  notes: r.notes, managerNotes: r.manager_notes, cancelReason: r.cancel_reason,
  invoice: invoiceOf(r), createdAt: r.created_at, updatedAt: r.updated_at, ...extra,
});

async function load(bookingId) {
  const { rows } = await query(`SELECT ${SELECT} ${FROM} WHERE b.id = $1`, [bookingId]);
  if (!rows.length) throw new HttpError(404, "Booking not found");
  const [t, e] = await Promise.all([
    query(`SELECT id, first_name, last_name, category, document_number, dietary, single_room FROM travel_booking_travellers WHERE booking_id = $1 ORDER BY sort, id`, [bookingId]),
    query(`SELECT e.id, e.action, e.note, e.created_at, a.display_name AS actor FROM travel_booking_events e LEFT JOIN auth_accounts a ON a.id = e.actor_account_id WHERE e.booking_id = $1 ORDER BY e.created_at, e.id`, [bookingId]),
  ]);
  return serialize(rows[0], {
    travellers: t.rows.map((x) => ({ id: x.id, firstName: x.first_name, lastName: x.last_name, category: x.category, documentNumber: x.document_number, dietary: x.dietary, singleRoom: x.single_room })),
    events: e.rows.map((x) => ({ id: x.id, action: x.action, note: x.note, actorName: x.actor, createdAt: x.created_at })),
  });
}

const event = (client, bookingId, actorId, action, note) =>
  client.query(`INSERT INTO travel_booking_events (booking_id, actor_account_id, action, note) VALUES ($1,$2,$3,$4)`, [bookingId, actorId, action, note ?? null]);

const totals = (list, unit, supplement) => {
  const seats = list.length;
  const singles = list.filter((x) => x.singleRoom).length;
  return { seats, singles, total: seats * unit + singles * supplement };
};

/** Runs fn inside a transaction. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function checkSeats(client, pkg, wanted, excludeId) {
  if (pkg.capacity == null) return;
  const { rows } = await client.query(
    `SELECT COALESCE(sum(seats),0)::int AS n FROM travel_bookings WHERE package_id = $1 AND status = ANY($2) AND ($3::uuid IS NULL OR id <> $3)`,
    [pkg.id, HELD, excludeId ?? null],
  );
  const left = pkg.capacity - rows[0].n;
  if (wanted > left) throw new HttpError(409, left <= 0 ? "This trip is full" : `Only ${left} seat${left === 1 ? "" : "s"} left on this trip`);
}

async function insertTravellers(client, bookingId, list) {
  for (let i = 0; i < list.length; i++) {
    const x = list[i];
    await client.query(
      `INSERT INTO travel_booking_travellers (booking_id, first_name, last_name, category, document_number, dietary, single_room, sort) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [bookingId, x.firstName, x.lastName, x.category ?? "adult", x.documentNumber ?? null, x.dietary ?? null, !!x.singleRoom, i],
    );
  }
}

// ---- list / get ------------------------------------------------------------------
const list = wrap(async (req, res) => {
  const where = [];
  const vals = [];
  if (req.query.status) {
    const s = String(req.query.status).split(",").filter((x) => ["pending", "confirmed", "cancelled", "completed"].includes(x));
    if (s.length) { vals.push(s); where.push(`b.status = ANY($${vals.length})`); }
  }
  if (req.query.packageId) { vals.push(uuid(req.query.packageId, "Trip not found")); where.push(`b.package_id = $${vals.length}`); }
  if (req.query.q) {
    vals.push(`%${String(req.query.q).trim().replace(/[\\%_]/g, "\\$&")}%`);
    where.push(`(b.reference ILIKE $${vals.length} OR b.contact_name ILIKE $${vals.length} OR b.contact_email ILIKE $${vals.length} OR b.organisation ILIKE $${vals.length} OR b.invoice_number ILIKE $${vals.length})`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const [rows, total, counts] = await Promise.all([
    query(`SELECT ${SELECT} ${FROM} ${clause} ORDER BY b.created_at DESC LIMIT ${limit} OFFSET ${offset}`, vals),
    query(`SELECT count(*)::int AS n ${FROM} ${clause}`, vals),
    query(`SELECT status, count(*)::int AS n FROM travel_bookings GROUP BY status`),
  ]);
  res.json({ data: rows.rows.map((r) => serialize(r)), total: total.rows[0].n, counts: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])) });
});

const get = wrap(async (req, res) => res.json({ data: await load(uuid(req.params.id)) }));

// ---- create ----------------------------------------------------------------------
const AUDIENCE_OF = { fan: "fans", group: "groups", organiser: "organisers" };
/**
 * Creates a booking and returns its id. `online` applies the public rules: the trip must be
 * published, still open for booking, and meant for this kind of customer. Managers may also book closed trips.
 */
async function createBooking(packageId, b, { actorId = null, online = false } = {}) {
  needs(b);
  return tx(async (client) => {
    const pkg = (await client.query(
      `SELECT id, status, capacity, price_cents, single_supplement_cents, currency, audiences,
              end_date::text AS end_date, booking_deadline::text AS booking_deadline
         FROM travel_packages WHERE id = $1 FOR UPDATE`, [packageId],
    )).rows[0];
    if (!pkg) throw new HttpError(404, "Trip not found");
    const today = new Date().toISOString().slice(0, 10);
    if (online) {
      if (pkg.status !== "published") throw new HttpError(409, "This trip isn't open for booking");
      if (pkg.end_date < today || (pkg.booking_deadline && pkg.booking_deadline < today)) throw new HttpError(409, "Booking for this trip has closed");
      if (!pkg.audiences.includes(AUDIENCE_OF[b.customerType])) throw new HttpError(400, "This trip isn't offered to that kind of customer");
    } else if (!["published", "closed"].includes(pkg.status)) {
      throw new HttpError(409, "Bookings can only be made on a published trip");
    }
    const sum = totals(b.travellers, pkg.price_cents, pkg.single_supplement_cents);
    await checkSeats(client, pkg, sum.seats);
    const { rows } = await client.query(
      `INSERT INTO travel_bookings (reference, package_id, customer_type, contact_name, contact_email, contact_phone, organisation, currency,
          unit_price_cents, single_supplement_cents, seats, single_rooms, total_cents, notes, created_by)
       VALUES ('TB-' || nextval('public.travel_booking_seq')::text, $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [packageId, b.customerType, b.contactName, b.contactEmail ?? null, b.contactPhone ?? null, b.organisation ?? null, pkg.currency,
        pkg.price_cents, pkg.single_supplement_cents, sum.seats, sum.singles, sum.total, b.notes ?? null, actorId],
    );
    await insertTravellers(client, rows[0].id, b.travellers);
    await event(client, rows[0].id, actorId, "created", online ? "Booked online by the customer" : "Booking created by STL");
    return rows[0].id;
  });
}

const create = wrap(async (req, res) => {
  const packageId = uuid(req.params.id, "Trip not found");
  const id = await createBooking(packageId, createBody.parse(req.body), { actorId: req.user.id });
  res.status(201).json({ data: await load(id) });
});

// ---- edit ------------------------------------------------------------------------
const COLS = { customerType: "customer_type", contactName: "contact_name", contactEmail: "contact_email", contactPhone: "contact_phone", organisation: "organisation", notes: "notes", managerNotes: "manager_notes" };
const update = wrap(async (req, res) => {
  const bid = uuid(req.params.id);
  const cur = (await query(`SELECT customer_type, contact_email, contact_phone, organisation FROM travel_bookings WHERE id = $1`, [bid])).rows[0];
  if (!cur) throw new HttpError(404, "Booking not found");
  const p = patchBody.parse(req.body);
  const sets = [];
  const vals = [bid];
  for (const [k, col] of Object.entries(COLS)) {
    if (p[k] === undefined) continue;
    vals.push(p[k] ?? null);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, "Nothing to update");
  needs({
    customerType: p.customerType ?? cur.customer_type,
    contactEmail: p.contactEmail === undefined ? cur.contact_email : p.contactEmail,
    contactPhone: p.contactPhone === undefined ? cur.contact_phone : p.contactPhone,
    organisation: p.organisation === undefined ? cur.organisation : p.organisation,
  });
  await query(`UPDATE travel_bookings SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
  res.json({ data: await load(bid) });
});

const setTravellers = wrap(async (req, res) => {
  const bid = uuid(req.params.id);
  const list = travellers.parse(req.body?.travellers);
  await tx(async (client) => {
    const cur = (await client.query(`SELECT id, package_id, status, unit_price_cents, single_supplement_cents, invoice_number, invoice_voided_at FROM travel_bookings WHERE id = $1 FOR UPDATE`, [bid])).rows[0];
    if (!cur) throw new HttpError(404, "Booking not found");
    if (!["pending", "confirmed"].includes(cur.status)) throw new HttpError(409, `A ${cur.status} booking can't be changed`);
    if (cur.invoice_number && !cur.invoice_voided_at) throw new HttpError(409, "An invoice has been issued. Its travellers and price can't change.");
    const pkg = (await client.query(`SELECT id, capacity FROM travel_packages WHERE id = $1 FOR UPDATE`, [cur.package_id])).rows[0];
    const sum = totals(list, cur.unit_price_cents, cur.single_supplement_cents);
    await checkSeats(client, pkg, sum.seats, bid);
    await client.query(`DELETE FROM travel_booking_travellers WHERE booking_id = $1`, [bid]);
    await insertTravellers(client, bid, list);
    await client.query(`UPDATE travel_bookings SET seats = $2, single_rooms = $3, total_cents = $4, updated_at = now() WHERE id = $1`, [bid, sum.seats, sum.singles, sum.total]);
    await event(client, bid, req.user.id, "travellers_updated", `${sum.seats} traveller${sum.seats === 1 ? "" : "s"}`);
  });
  res.json({ data: await load(bid) });
});

// ---- status ----------------------------------------------------------------------
const MOVES = { pending: ["confirmed", "cancelled"], confirmed: ["completed", "cancelled"], completed: [], cancelled: [] };
const setStatus = wrap(async (req, res) => {
  const bid = uuid(req.params.id);
  const { status, reason } = z.object({ status: z.enum(["confirmed", "completed", "cancelled"]), reason: opt(500) }).parse(req.body);
  await tx(async (client) => {
    const cur = (await client.query(`SELECT status, invoice_number, invoice_paid_at, invoice_voided_at FROM travel_bookings WHERE id = $1 FOR UPDATE`, [bid])).rows[0];
    if (!cur) throw new HttpError(404, "Booking not found");
    if (!MOVES[cur.status].includes(status)) throw new HttpError(409, `A ${cur.status} booking can't become ${status}`);
    let voided = false;
    if (status === "cancelled") {
      if (cur.invoice_paid_at) throw new HttpError(409, "This booking's invoice is paid. Mark it unpaid (after any refund) before cancelling.");
      voided = !!cur.invoice_number && !cur.invoice_voided_at;
    }
    await client.query(
      `UPDATE travel_bookings SET status = $2, cancel_reason = CASE WHEN $2 = 'cancelled' THEN $3 ELSE cancel_reason END,
              invoice_voided_at = CASE WHEN $4 THEN now() ELSE invoice_voided_at END, updated_at = now() WHERE id = $1`,
      [bid, status, reason ?? null, voided],
    );
    await event(client, bid, req.user.id, status, reason);
    if (voided) await event(client, bid, req.user.id, "invoice_voided", `Invoice ${cur.invoice_number} voided with the cancellation`);
  });
  const done = await load(bid);
  if (status !== "completed") notify.travelBookingStatus(done, reason);
  res.json({ data: done });
});

// ---- invoice (reuses the shared numbering, billing settings and PDF layout) -------
const issueInvoice = wrap(async (req, res) => {
  const bid = uuid(req.params.id);
  const { dueDate } = z.object({ dueDate: z.preprocess(blank, z.iso.date().nullable().optional()) }).parse(req.body ?? {});
  const settings = await invoiceRepo.getSettings();
  await tx(async (client) => {
    const cur = (await client.query(
      `SELECT b.status, b.total_cents, b.invoice_number, b.contact_name, b.contact_email, b.organisation FROM travel_bookings b WHERE b.id = $1 FOR UPDATE`, [bid],
    )).rows[0];
    if (!cur) throw new HttpError(404, "Booking not found");
    if (!["pending", "confirmed"].includes(cur.status)) throw new HttpError(409, `A ${cur.status} booking can't be invoiced`);
    if (cur.invoice_number) throw new HttpError(409, "An invoice has already been issued for this booking");
    if (Number(cur.total_cents) <= 0) throw new HttpError(400, "The booking total must be above zero to invoice it");
    if (dueDate && dueDate < new Date().toISOString().slice(0, 10)) throw new HttpError(400, "The due date can't be in the past");
    const year = new Date().getUTCFullYear();
    const counter = await client.query(
      `INSERT INTO invoice_counters (year, last_number) VALUES ($1, 1) ON CONFLICT (year) DO UPDATE SET last_number = invoice_counters.last_number + 1 RETURNING last_number`, [year],
    );
    const number = `INV-${year}-${String(counter.rows[0].last_number).padStart(4, "0")}`;
    const snapshot = {
      issuer: {
        companyName: settings.company_name, companyAddress: settings.company_address, companyEmail: settings.company_email,
        companyPhone: settings.company_phone, taxNumber: settings.tax_number, paymentInstructions: settings.payment_instructions,
        invoiceFooter: settings.invoice_footer, bankName: settings.bank_name, bankAccountName: settings.bank_account_name,
        bankAccountNumber: settings.bank_account_number, bankSwiftCode: settings.bank_swift_code,
      },
      billTo: { teamName: cur.organisation || cur.contact_name, contactName: cur.organisation ? cur.contact_name : null, contactEmail: cur.contact_email },
    };
    await client.query(
      `UPDATE travel_bookings SET invoice_number = $2, invoice_issued_at = now(),
              invoice_due_date = COALESCE($3::date, CURRENT_DATE + $4::int), invoice_snapshot = $5, updated_at = now() WHERE id = $1`,
      [bid, number, dueDate ?? null, settings.payment_terms_days, JSON.stringify(snapshot)],
    );
    await event(client, bid, req.user.id, "invoice_issued", `Invoice ${number} issued`);
  });
  const done = await load(bid);
  if (done.contactEmail) buildInvoicePdf(bid).then(({ pdf }) => notify.travelBookingInvoice(done, pdf)).catch((e) => console.error("[notify] booking invoice failed:", e.message));
  res.json({ data: done });
});

const markPaid = (paid) => wrap(async (req, res) => {
  const bid = uuid(req.params.id);
  await tx(async (client) => {
    const cur = (await client.query(`SELECT status, invoice_number, invoice_paid_at, invoice_voided_at FROM travel_bookings WHERE id = $1 FOR UPDATE`, [bid])).rows[0];
    if (!cur) throw new HttpError(404, "Booking not found");
    if (!cur.invoice_number || cur.invoice_voided_at) throw new HttpError(409, "There's no open invoice on this booking");
    if (paid && cur.invoice_paid_at) throw new HttpError(409, "The invoice is already marked paid");
    if (!paid && !cur.invoice_paid_at) throw new HttpError(409, "The invoice isn't marked paid");
    await client.query(`UPDATE travel_bookings SET invoice_paid_at = ${paid ? "now()" : "NULL"}, updated_at = now() WHERE id = $1`, [bid]);
    await event(client, bid, req.user.id, paid ? "invoice_paid" : "invoice_unpaid", `Invoice ${cur.invoice_number} ${paid ? "marked paid" : "marked unpaid"}`);
  });
  res.json({ data: await load(bid) });
});

async function buildInvoicePdf(bid) {
  const { rows } = await query(`SELECT ${SELECT} ${FROM} WHERE b.id = $1`, [bid]);
  const r = rows[0];
  if (!r) throw new HttpError(404, "Booking not found");
  if (!r.invoice_number) throw new HttpError(404, "The invoice hasn't been issued yet");
  const items = [{
    description: `${r.package_title} - ${r.seats} traveller${r.seats === 1 ? "" : "s"}`, quantity: r.seats, unit_price: r.unit_price_cents / 100, line_total: (r.seats * r.unit_price_cents) / 100,
  }];
  if (r.single_rooms > 0)
    items.push({ description: "Single room supplement", quantity: r.single_rooms, unit_price: r.single_supplement_cents / 100, line_total: (r.single_rooms * r.single_supplement_cents) / 100 });
  const total = Number(r.total_cents) / 100;
  const pdf = await renderInvoice({
    invoice_number: r.invoice_number, status: r.invoice_voided_at ? "void" : r.invoice_paid_at ? "paid" : "issued",
    reference: r.reference, event_name: r.package_event || r.package_title, origin: null, destination: r.package_destination,
    departure_date: r.package_start, return_date: r.package_end, issue_date: r.invoice_issued_at ? new Date(r.invoice_issued_at).toISOString().slice(0, 10) : null,
    due_date: r.due_date, currency: String(r.currency).trim(), items, subtotal: total, tax_rate: 0, tax_amount: 0, total, notes: null,
    void_reason: r.cancel_reason, snapshot: r.invoice_snapshot,
  }, null);
  return { pdf, number: r.invoice_number };
}
const sendPdf = (res, { pdf, number }) => {
  res.set({ "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${number}.pdf"`, "Cache-Control": "private, no-store", "Content-Length": pdf.length });
  res.send(pdf);
};
const invoicePdf = wrap(async (req, res) => sendPdf(res, await buildInvoicePdf(uuid(req.params.id))));

module.exports = { createBooking, createBody, buildInvoicePdf, sendPdf, serialize, list, get, create, update, setTravellers, setStatus, issueInvoice, paid: markPaid(true), unpaid: markPaid(false), invoicePdf, load };
