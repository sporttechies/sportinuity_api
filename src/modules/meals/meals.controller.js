// Meal schedule for a request (manager side) plus shared loading used by the team side.
const { z } = require("zod");
const { query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");
const { summariseDietary } = require("./meals.dietary");

const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack", "packed"];
const DEFAULT_TIMES = { breakfast: "07:30", lunch: "13:00", dinner: "19:30", snack: null, packed: null };
const blank = (v) => (v === "" ? null : v);
const text = (max) => z.preprocess(blank, z.string().trim().max(max).nullable().optional());

const mealFields = {
  mealDate: z.iso.date({ error: "Choose a date" }),
  mealType: z.enum(MEAL_TYPES, { error: "Choose a meal type" }),
  mealTime: z.preprocess(blank, z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 19:30").nullable().optional()),
  venue: text(200),
  headcount: z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().int().min(1).max(2000).nullable().optional()),
  menu: text(1000),
  notes: text(500),
};
const createBody = z.object(mealFields);
const patchBody = z.object({ ...Object.fromEntries(Object.entries(mealFields).map(([k, v]) => [k, v.optional()])), status: z.enum(["planned", "confirmed"]).optional() });

async function requestByReference(reference) {
  const { rows } = await query(
    `SELECT lr.id, lr.reference, lr.status, lr.event_name, lr.destination, lr.traveller_count,
            lr.departure_date::text AS departure_date, lr.return_date::text AS return_date
       FROM logistics_requests lr WHERE lr.reference = $1 AND lr.deleted_at IS NULL`,
    [String(reference).toUpperCase()],
  );
  if (!rows.length) throw new HttpError(404, "Request not found");
  return rows[0];
}

const serializeMeal = (m) => ({
  id: m.id,
  date: m.meal_date,
  type: m.meal_type,
  time: m.meal_time ? String(m.meal_time).slice(0, 5) : null,
  venue: m.venue,
  headcount: m.headcount,
  menu: m.menu,
  notes: m.notes,
  status: m.status,
});

/** Everything for the schedule; teams only get confirmed meals. */
async function loadMeals(request, { confirmedOnly = false } = {}) {
  const meals = await query(
    `SELECT id, meal_date::text AS meal_date, meal_type, meal_time, venue, headcount, menu, notes, status
       FROM meals WHERE logistics_request_id = $1 ${confirmedOnly ? "AND status = 'confirmed'" : ""}
      ORDER BY meal_date, meal_time NULLS LAST, array_position(ARRAY['breakfast','lunch','dinner','snack','packed'], meal_type), created_at`,
    [request.id],
  );
  const people = await query(
    `SELECT id, first_name, last_name, dietary_needs FROM request_travellers
      WHERE logistics_request_id = $1 ORDER BY traveller_index`,
    [request.id],
  );
  return {
    reference: request.reference,
    event: request.event_name,
    destination: request.destination,
    checkIn: request.departure_date,
    checkOut: request.return_date,
    travellerCount: people.rows.length,
    meals: meals.rows.map(serializeMeal),
    dietary: summariseDietary(
      people.rows.map((p) => ({ id: p.id, firstName: p.first_name, lastName: p.last_name, dietary: p.dietary_needs })),
    ),
  };
}

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

const get = wrap(async (req, res) => {
  res.json({ data: await loadMeals(await requestByReference(req.params.reference)) });
});

const create = wrap(async (req, res) => {
  const request = await requestByReference(req.params.reference);
  const m = createBody.parse(req.body);
  await query(
    `INSERT INTO meals (logistics_request_id, meal_date, meal_type, meal_time, venue, headcount, menu, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [request.id, m.mealDate, m.mealType, m.mealTime ?? DEFAULT_TIMES[m.mealType], m.venue ?? null, m.headcount ?? null, m.menu ?? null, m.notes ?? null],
  );
  res.status(201).json({ data: await loadMeals(request) });
});

const generate = wrap(async (req, res) => {
  const request = await requestByReference(req.params.reference);
  const { types } = z
    .object({ types: z.array(z.enum(MEAL_TYPES)).min(1, "Pick at least one meal type").default(["breakfast", "dinner"]) })
    .parse(req.body ?? {});
  if (!request.departure_date || !request.return_date)
    throw new HttpError(400, "This request has no travel dates yet, so meals can't be generated");
  const start = new Date(`${request.departure_date}T00:00:00Z`);
  const end = new Date(`${request.return_date}T00:00:00Z`);
  const days = Math.round((end - start) / 86400000) + 1;
  if (days < 1 || days > 60) throw new HttpError(400, "The trip dates look wrong for generating meals");
  const existing = await query(`SELECT meal_date::text AS d, meal_type FROM meals WHERE logistics_request_id = $1`, [request.id]);
  const have = new Set(existing.rows.map((r) => `${r.d}|${r.meal_type}`));
  let added = 0;
  for (let i = 0; i < days; i++) {
    const date = new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10);
    for (const type of types) {
      if (have.has(`${date}|${type}`)) continue;
      await query(
        `INSERT INTO meals (logistics_request_id, meal_date, meal_type, meal_time) VALUES ($1,$2,$3,$4)`,
        [request.id, date, type, DEFAULT_TIMES[type]],
      );
      added += 1;
    }
  }
  if (!added) throw new HttpError(409, "Those meals are already in the schedule");
  res.status(201).json({ data: await loadMeals(request) });
});

async function mealRequest(id) {
  const { rows } = await query(
    `SELECT lr.id, lr.reference, lr.status, lr.event_name, lr.destination, lr.traveller_count,
            lr.departure_date::text AS departure_date, lr.return_date::text AS return_date
       FROM meals m JOIN logistics_requests lr ON lr.id = m.logistics_request_id
      WHERE m.id = $1 AND lr.deleted_at IS NULL`,
    [z.uuid().parse(id)],
  );
  if (!rows.length) throw new HttpError(404, "Meal not found");
  return rows[0];
}

const update = wrap(async (req, res) => {
  const request = await mealRequest(req.params.id);
  const p = patchBody.parse(req.body);
  const sets = [];
  const vals = [req.params.id];
  const col = { mealDate: "meal_date", mealType: "meal_type", mealTime: "meal_time", venue: "venue", headcount: "headcount", menu: "menu", notes: "notes", status: "status" };
  for (const [key, column] of Object.entries(col)) {
    if (p[key] === undefined) continue;
    vals.push(p[key] ?? null);
    sets.push(`${column} = $${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, "Nothing to update");
  await query(`UPDATE meals SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
  res.json({ data: await loadMeals(request) });
});

const remove = wrap(async (req, res) => {
  const request = await mealRequest(req.params.id);
  await query(`DELETE FROM meals WHERE id = $1`, [req.params.id]);
  res.json({ data: await loadMeals(request) });
});

/** Confirms every planned meal so the team can see the schedule. */
const confirmAll = wrap(async (req, res) => {
  const request = await requestByReference(req.params.reference);
  const done = await query(
    `UPDATE meals SET status = 'confirmed', updated_at = now() WHERE logistics_request_id = $1 AND status = 'planned'`,
    [request.id],
  );
  if (!done.rowCount) throw new HttpError(409, "There are no planned meals to confirm");
  await query(
    `INSERT INTO request_events (logistics_request_id, actor_account_id, actor_role, action, note)
     VALUES ($1,$2,'manager','meals_confirmed',$3)`,
    [request.id, req.user.id, `${done.rowCount} meal${done.rowCount === 1 ? "" : "s"} confirmed`],
  );
  res.json({ data: await loadMeals(request) });
});

const pdf = wrap(async (req, res) => {
  const request = await requestByReference(req.params.reference);
  const team = await query(`SELECT tp.name FROM logistics_requests lr LEFT JOIN team_profiles tp ON tp.id = lr.team_profile_id WHERE lr.id = $1`, [request.id]);
  const { renderMealPlan } = require("./meals.pdf");
  const buffer = await renderMealPlan(await loadMeals(request), { teamName: team.rows[0]?.name, draft: true });
  sendPdf(res, buffer, `meals-${request.reference}.pdf`);
});

function sendPdf(res, buffer, filename) {
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${filename}"`,
    "Cache-Control": "private, no-store",
    "Content-Length": buffer.length,
  });
  res.send(buffer);
}

module.exports = { get, create, generate, update, remove, confirmAll, pdf, loadMeals, requestByReference, sendPdf };
