// Sports Travel trip packages and itineraries (manager side).
const { z } = require("zod");
const { query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");

const AUDIENCES = ["fans", "groups", "organisers"];
const KINDS = ["flight", "accommodation", "transfer", "meal", "activity", "event", "free_time", "other"];
const blank = (v) => (v === "" ? null : v);
const opt = (max) => z.preprocess(blank, z.string().trim().max(max).nullable().optional());
const money = (label) =>
  z.preprocess((v) => (v === "" || v == null ? undefined : Number(v)), z.number({ error: `Enter ${label}` }).int().min(0).max(1_000_000_000));
const num = z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().int().min(1).max(100000).nullable().optional());
const date = z.iso.date({ error: "Choose a date" });

const packageFields = {
  title: z.string().trim().min(3, "Give the trip a title").max(160),
  eventName: opt(160),
  destination: z.string().trim().min(2, "Enter the destination").max(160),
  country: z.preprocess(blank, z.string().trim().length(2).toUpperCase().nullable().optional()),
  startDate: date,
  endDate: date,
  summary: opt(300),
  description: opt(8000),
  audiences: z.array(z.enum(AUDIENCES)).min(1, "Choose who this trip is for").max(3),
  priceCents: money("a price"),
  singleSupplementCents: z.preprocess((v) => (v === "" || v == null ? undefined : Number(v)), z.number().int().min(0).max(1_000_000_000).optional()),
  currency: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{3}$/, "Use a 3-letter currency code")).optional(),
  capacity: num,
  bookingDeadline: z.preprocess(blank, date.nullable().optional()),
  coverImageUrl: z.preprocess(blank, z.string().trim().url().max(500).nullable().optional()),
  inclusions: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  exclusions: opt(1000),
};
const createBody = z.object(packageFields);
const patchBody = z.object(Object.fromEntries(Object.entries(packageFields).map(([k, v]) => [k, v.optional()])));
const COLUMNS = {
  title: "title", eventName: "event_name", destination: "destination", country: "country", startDate: "start_date", endDate: "end_date",
  summary: "summary", description: "description", audiences: "audiences", priceCents: "price_cents",
  singleSupplementCents: "single_supplement_cents", currency: "currency", capacity: "capacity", bookingDeadline: "booking_deadline",
  coverImageUrl: "cover_image_url", inclusions: "inclusions", exclusions: "exclusions",
};

const itemFields = {
  dayNumber: z.coerce.number().int().min(1).max(60),
  kind: z.enum(KINDS, { error: "Choose an item type" }),
  title: z.string().trim().min(2, "Give the item a title").max(160),
  details: opt(1000),
  startTime: z.preprocess(blank, z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 09:30").nullable().optional()),
};
const itemBody = z.object(itemFields);
const itemPatch = z.object(Object.fromEntries(Object.entries(itemFields).map(([k, v]) => [k, v.optional()])));

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};
const id = (v) => z.uuid({ error: "Trip not found" }).parse(v);
const hhmm = (v) => (v ? String(v).slice(0, 5) : null);

const SELECT = `p.id, p.slug, p.title, p.event_name, p.destination, p.country, p.start_date::text AS start_date, p.end_date::text AS end_date,
  p.summary, p.description, p.audiences, p.price_cents, p.single_supplement_cents, p.currency, p.capacity,
  p.booking_deadline::text AS booking_deadline, p.cover_image_url, p.inclusions, p.exclusions, p.status, p.published_at, p.created_at, p.updated_at,
  (SELECT count(*)::int FROM travel_itinerary_items i WHERE i.package_id = p.id) AS item_count,
  COALESCE((SELECT sum(b.seats) FROM travel_bookings b WHERE b.package_id = p.id AND b.status IN ('pending','confirmed','completed')), 0)::int AS seats_taken`

const serialize = (r, items) => ({
  id: r.id, slug: r.slug, title: r.title, eventName: r.event_name, destination: r.destination, country: r.country,
  startDate: r.start_date, endDate: r.end_date, summary: r.summary, description: r.description, audiences: r.audiences,
  priceCents: r.price_cents, singleSupplementCents: r.single_supplement_cents, currency: r.currency, capacity: r.capacity,
  bookingDeadline: r.booking_deadline, coverImageUrl: r.cover_image_url, inclusions: r.inclusions, exclusions: r.exclusions,
  status: r.status, publishedAt: r.published_at, createdAt: r.created_at, updatedAt: r.updated_at, itemCount: r.item_count, seatsTaken: r.seats_taken,
  ...(items ? { itinerary: items } : {}),
});
const serializeItem = (i) => ({ id: i.id, dayNumber: i.day_number, kind: i.kind, title: i.title, details: i.details, startTime: hhmm(i.start_time) });

async function itineraryOf(packageId) {
  const { rows } = await query(
    `SELECT id, day_number, kind, title, details, start_time FROM travel_itinerary_items
      WHERE package_id = $1 ORDER BY day_number, start_time NULLS LAST, sort, created_at`,
    [packageId],
  );
  return rows.map(serializeItem);
}

async function load(packageId) {
  const { rows } = await query(`SELECT ${SELECT} FROM travel_packages p WHERE p.id = $1`, [packageId]);
  if (!rows.length) throw new HttpError(404, "Trip not found");
  return serialize(rows[0], await itineraryOf(packageId));
}

const slugify = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "trip";
async function uniqueSlug(title, startDate) {
  const base = `${slugify(title)}-${String(startDate).slice(0, 4)}`;
  for (let n = 0; n < 50; n++) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;
    const { rows } = await query(`SELECT 1 FROM travel_packages WHERE slug = $1`, [slug]);
    if (!rows.length) return slug;
  }
  throw new HttpError(500, "Could not create a unique trip address");
}

function checkDates({ startDate, endDate, bookingDeadline }) {
  if (startDate && endDate && endDate < startDate) throw new HttpError(400, "The trip can't end before it starts");
  if (bookingDeadline && endDate && bookingDeadline > endDate) throw new HttpError(400, "The booking deadline must be before the trip ends");
}

const list = wrap(async (req, res) => {
  const where = [];
  const vals = [];
  if (req.query.status) {
    const statuses = String(req.query.status).split(",").filter((s) => ["draft", "published", "closed", "archived"].includes(s));
    if (statuses.length) { vals.push(statuses); where.push(`p.status = ANY($${vals.length})`); }
  }
  if (req.query.q) { vals.push(`%${String(req.query.q).trim()}%`); where.push(`(p.title ILIKE $${vals.length} OR p.destination ILIKE $${vals.length} OR p.event_name ILIKE $${vals.length})`); }
  const { rows } = await query(
    `SELECT ${SELECT} FROM travel_packages p ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY p.start_date DESC, p.title LIMIT 200`,
    vals,
  );
  const counts = await query(`SELECT status, count(*)::int AS n FROM travel_packages GROUP BY status`);
  res.json({ data: rows.map((r) => serialize(r)), counts: Object.fromEntries(counts.rows.map((c) => [c.status, c.n])) });
});

const get = wrap(async (req, res) => res.json({ data: await load(id(req.params.id)) }));

const create = wrap(async (req, res) => {
  const b = createBody.parse(req.body);
  checkDates(b);
  const slug = await uniqueSlug(b.title, b.startDate);
  const { rows } = await query(
    `INSERT INTO travel_packages (slug, title, event_name, destination, country, start_date, end_date, summary, description, audiences,
        price_cents, single_supplement_cents, currency, capacity, booking_deadline, cover_image_url, inclusions, exclusions, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [slug, b.title, b.eventName ?? null, b.destination, b.country ?? null, b.startDate, b.endDate, b.summary ?? null, b.description ?? null,
      [...new Set(b.audiences)], b.priceCents, b.singleSupplementCents ?? 0, b.currency ?? "USD", b.capacity ?? null, b.bookingDeadline ?? null,
      b.coverImageUrl ?? null, b.inclusions ?? [], b.exclusions ?? null, req.user.id],
  );
  res.status(201).json({ data: await load(rows[0].id) });
});

const update = wrap(async (req, res) => {
  const pid = id(req.params.id);
  const cur = (await query(`SELECT start_date::text AS s, end_date::text AS e, booking_deadline::text AS d, status FROM travel_packages WHERE id = $1`, [pid])).rows[0];
  if (!cur) throw new HttpError(404, "Trip not found");
  const p = patchBody.parse(req.body);
  const sets = [];
  const vals = [pid];
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (p[key] === undefined) continue;
    vals.push(key === "audiences" ? [...new Set(p[key])] : p[key] ?? null);
    sets.push(`${column} = $${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, "Nothing to update");
  checkDates({
    startDate: p.startDate ?? cur.s,
    endDate: p.endDate ?? cur.e,
    bookingDeadline: p.bookingDeadline === undefined ? cur.d : p.bookingDeadline,
  });
  if (p.capacity != null) {
    const taken = (await query(`SELECT COALESCE(sum(seats),0)::int AS n FROM travel_bookings WHERE package_id = $1 AND status IN ('pending','confirmed','completed')`, [pid])).rows[0].n;
    if (p.capacity < taken) throw new HttpError(409, `${taken} seats are already booked. Seats can't go below that.`);
  }
  await query(`UPDATE travel_packages SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
  res.json({ data: await load(pid) });
});

/** draft -> published needs the basics filled in. Other moves: published <-> closed, anything -> archived, archived -> draft. */
const TRANSITIONS = { draft: ["published", "archived"], published: ["closed", "draft", "archived"], closed: ["published", "archived"], archived: ["draft"] };
const setStatus = wrap(async (req, res) => {
  const pid = id(req.params.id);
  const { status } = z.object({ status: z.enum(["draft", "published", "closed", "archived"]) }).parse(req.body);
  const pkg = await load(pid);
  if (!TRANSITIONS[pkg.status].includes(status)) throw new HttpError(409, `A ${pkg.status} trip can't become ${status}`);
  if (status === "draft" && pkg.seatsTaken > 0) throw new HttpError(409, "This trip has bookings, so it can't go back to draft. Close it instead.");
  if (status === "published") {
    const missing = [];
    if (!pkg.summary) missing.push("a short summary");
    if (!pkg.itinerary.length) missing.push("at least one itinerary item");
    if (pkg.priceCents <= 0) missing.push("a price");
    if (pkg.endDate < new Date().toISOString().slice(0, 10)) missing.push("dates in the future");
    if (missing.length) throw new HttpError(400, `Before publishing, add ${missing.join(", ")}.`);
  }
  await query(
    `UPDATE travel_packages SET status = $2, updated_at = now(), published_at = CASE WHEN $2 = 'published' AND published_at IS NULL THEN now() ELSE published_at END WHERE id = $1`,
    [pid, status],
  );
  res.json({ data: await load(pid) });
});

const duplicate = wrap(async (req, res) => {
  const src = await load(id(req.params.id));
  const title = `${src.title} (copy)`;
  const slug = await uniqueSlug(title, src.startDate);
  const { rows } = await query(
    `INSERT INTO travel_packages (slug, title, event_name, destination, country, start_date, end_date, summary, description, audiences,
        price_cents, single_supplement_cents, currency, capacity, booking_deadline, cover_image_url, inclusions, exclusions, created_by)
     SELECT $2, $3, event_name, destination, country, start_date, end_date, summary, description, audiences,
        price_cents, single_supplement_cents, currency, capacity, booking_deadline, cover_image_url, inclusions, exclusions, $4
       FROM travel_packages WHERE id = $1 RETURNING id`,
    [src.id, slug, title, req.user.id],
  );
  await query(
    `INSERT INTO travel_itinerary_items (package_id, day_number, kind, title, details, start_time, sort)
     SELECT $2, day_number, kind, title, details, start_time, sort FROM travel_itinerary_items WHERE package_id = $1`,
    [src.id, rows[0].id],
  );
  res.status(201).json({ data: await load(rows[0].id) });
});

const remove = wrap(async (req, res) => {
  const pid = id(req.params.id);
  const pkg = await load(pid);
  if (pkg.status !== "draft" && pkg.status !== "archived") throw new HttpError(409, "Only draft or archived trips can be deleted. Archive it instead.");
  if ((await query(`SELECT 1 FROM travel_bookings WHERE package_id = $1 LIMIT 1`, [pid])).rows.length)
    throw new HttpError(409, "This trip has bookings, so it can't be deleted. Archive it instead.");
  await query(`DELETE FROM travel_packages WHERE id = $1`, [pid]);
  res.json({ ok: true });
});

// ---- itinerary
const dayCheck = (pkg, day) => {
  const days = Math.round((new Date(`${pkg.endDate}T00:00:00Z`) - new Date(`${pkg.startDate}T00:00:00Z`)) / 86400000) + 1;
  if (day > days) throw new HttpError(400, `This trip only has ${days} day${days === 1 ? "" : "s"}`);
};

const addItem = wrap(async (req, res) => {
  const pkg = await load(id(req.params.id));
  const b = itemBody.parse(req.body);
  dayCheck(pkg, b.dayNumber);
  const { rows: next } = await query(`SELECT COALESCE(max(sort), 0) + 1 AS n FROM travel_itinerary_items WHERE package_id = $1 AND day_number = $2`, [pkg.id, b.dayNumber]);
  await query(
    `INSERT INTO travel_itinerary_items (package_id, day_number, kind, title, details, start_time, sort) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [pkg.id, b.dayNumber, b.kind, b.title, b.details ?? null, b.startTime ?? null, next[0].n],
  );
  res.status(201).json({ data: await load(pkg.id) });
});

async function itemPackage(itemId) {
  const { rows } = await query(`SELECT package_id FROM travel_itinerary_items WHERE id = $1`, [z.uuid({ error: "Itinerary item not found" }).parse(itemId)]);
  if (!rows.length) throw new HttpError(404, "Itinerary item not found");
  return rows[0].package_id;
}

const updateItem = wrap(async (req, res) => {
  const pid = await itemPackage(req.params.itemId);
  const p = itemPatch.parse(req.body);
  const map = { dayNumber: "day_number", kind: "kind", title: "title", details: "details", startTime: "start_time" };
  const sets = [];
  const vals = [req.params.itemId];
  for (const [k, col] of Object.entries(map)) {
    if (p[k] === undefined) continue;
    vals.push(p[k] ?? null);
    sets.push(`${col} = $${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, "Nothing to update");
  if (p.dayNumber) dayCheck(await load(pid), p.dayNumber);
  await query(`UPDATE travel_itinerary_items SET ${sets.join(", ")} WHERE id = $1`, vals);
  res.json({ data: await load(pid) });
});

const removeItem = wrap(async (req, res) => {
  const pid = await itemPackage(req.params.itemId);
  await query(`DELETE FROM travel_itinerary_items WHERE id = $1`, [req.params.itemId]);
  res.json({ data: await load(pid) });
});

module.exports = { list, get, create, update, setStatus, duplicate, remove, addItem, updateItem, removeItem, load };
