// Transport legs for a request (manager side) plus shared loading used by the team side.
const { z } = require("zod");
const { pool, query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");

const MODES = ["flight", "transfer", "coach", "train", "ferry", "other"];
const blank = (v) => (v === "" ? null : v);
const text = (max) => z.preprocess(blank, z.string().trim().max(max).nullable().optional());
const time = z.preprocess(blank, z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 14:30").nullable().optional());
const date = z.iso.date({ error: "Choose a date" });

const fields = {
  mode: z.enum(MODES, { error: "Choose a transport type" }),
  fromLocation: z.string().trim().min(1, "Enter where it starts").max(200),
  toLocation: z.string().trim().min(1, "Enter where it goes").max(200),
  departDate: date,
  departTime: time,
  arriveDate: z.preprocess(blank, date.nullable().optional()),
  arriveTime: time,
  carrier: text(120),
  bookingReference: text(80),
  vehicle: text(120),
  driverName: text(120),
  driverPhone: text(40),
  meetingPoint: text(300),
  supplierId: z.preprocess(blank, z.uuid().nullable().optional()),
  notes: text(1000),
};
const createBody = z.object(fields);
const patchBody = z.object({
  ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])),
  status: z.enum(["planned", "confirmed"]).optional(),
});
const COLUMNS = {
  mode: "mode", fromLocation: "from_location", toLocation: "to_location", departDate: "depart_date", departTime: "depart_time",
  arriveDate: "arrive_date", arriveTime: "arrive_time", carrier: "carrier", bookingReference: "booking_reference", vehicle: "vehicle",
  driverName: "driver_name", driverPhone: "driver_phone", meetingPoint: "meeting_point", supplierId: "supplier_id", notes: "notes", status: "status",
};

const REQUEST_SQL = `SELECT lr.id, lr.reference, lr.status, lr.event_name, lr.origin, lr.destination, lr.traveller_count,
       lr.departure_date::text AS departure_date, lr.return_date::text AS return_date
  FROM logistics_requests lr`;

async function requestByReference(reference) {
  const { rows } = await query(`${REQUEST_SQL} WHERE lr.reference = $1 AND lr.deleted_at IS NULL`, [String(reference).toUpperCase()]);
  if (!rows.length) throw new HttpError(404, "Request not found");
  return rows[0];
}

const hhmm = (v) => (v ? String(v).slice(0, 5) : null);

async function loadTransport(request, { confirmedOnly = false, forTeam = false } = {}) {
  const legs = await query(
    `SELECT l.id, l.mode, l.from_location, l.to_location, l.depart_date::text AS depart_date, l.depart_time,
            l.arrive_date::text AS arrive_date, l.arrive_time, l.carrier, l.booking_reference, l.vehicle,
            l.driver_name, l.driver_phone, l.meeting_point, l.supplier_id, s.name AS supplier_name, l.notes, l.status
       FROM transport_legs l LEFT JOIN suppliers s ON s.id = l.supplier_id
      WHERE l.logistics_request_id = $1 ${confirmedOnly ? "AND l.status = 'confirmed'" : ""}
      ORDER BY l.depart_date, l.depart_time NULLS LAST, l.created_at`,
    [request.id],
  );
  const people = await query(
    `SELECT id, traveller_index, first_name, last_name FROM request_travellers WHERE logistics_request_id = $1 ORDER BY traveller_index`,
    [request.id],
  );
  const assigned = await query(
    `SELECT tp.leg_id, tp.traveller_id FROM transport_passengers tp
       JOIN transport_legs l ON l.id = tp.leg_id WHERE l.logistics_request_id = $1`,
    [request.id],
  );
  const byLeg = new Map();
  for (const a of assigned.rows) byLeg.set(a.leg_id, [...(byLeg.get(a.leg_id) ?? []), a.traveller_id]);
  const nameOf = new Map(people.rows.map((p) => [p.id, `${p.first_name} ${p.last_name}`.trim()]));
  return {
    reference: request.reference,
    event: request.event_name,
    origin: request.origin,
    destination: request.destination,
    travellerCount: people.rows.length,
    travellers: people.rows.map((p) => ({ id: p.id, index: p.traveller_index, name: nameOf.get(p.id) })),
    legs: legs.rows.map((l) => {
      const ids = byLeg.get(l.id) ?? null;
      return {
        id: l.id,
        mode: l.mode,
        from: l.from_location,
        to: l.to_location,
        departDate: l.depart_date,
        departTime: hhmm(l.depart_time),
        arriveDate: l.arrive_date,
        arriveTime: hhmm(l.arrive_time),
        carrier: l.carrier,
        bookingReference: l.booking_reference,
        vehicle: l.vehicle,
        driverName: l.driver_name,
        driverPhone: l.driver_phone,
        meetingPoint: l.meeting_point,
        status: l.status,
        // null = everyone on the request
        passengerIds: ids,
        passengerCount: ids ? ids.length : people.rows.length,
        passengers: ids ? ids.map((id) => nameOf.get(id)).filter(Boolean) : null,
        ...(forTeam ? {} : { notes: l.notes, supplierId: l.supplier_id, supplier: l.supplier_name }),
      };
    }),
  };
}

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

async function assertSupplier(id) {
  if (!id) return;
  const { rows } = await query(`SELECT 1 FROM suppliers WHERE id = $1`, [id]);
  if (!rows.length) throw new HttpError(400, "That supplier doesn't exist");
}

function checkDates(departDate, arriveDate) {
  if (departDate && arriveDate && arriveDate < departDate) throw new HttpError(400, "Arrival can't be before departure");
}

const get = wrap(async (req, res) => {
  res.json({ data: await loadTransport(await requestByReference(req.params.reference)) });
});

const create = wrap(async (req, res) => {
  const request = await requestByReference(req.params.reference);
  const b = createBody.parse(req.body);
  checkDates(b.departDate, b.arriveDate);
  await assertSupplier(b.supplierId);
  await query(
    `INSERT INTO transport_legs (logistics_request_id, mode, from_location, to_location, depart_date, depart_time, arrive_date, arrive_time,
       carrier, booking_reference, vehicle, driver_name, driver_phone, meeting_point, supplier_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [request.id, b.mode, b.fromLocation, b.toLocation, b.departDate, b.departTime ?? null, b.arriveDate ?? null, b.arriveTime ?? null,
      b.carrier ?? null, b.bookingReference ?? null, b.vehicle ?? null, b.driverName ?? null, b.driverPhone ?? null,
      b.meetingPoint ?? null, b.supplierId ?? null, b.notes ?? null],
  );
  res.status(201).json({ data: await loadTransport(request) });
});

async function legRequest(id) {
  const { rows } = await query(
    `${REQUEST_SQL} JOIN transport_legs l ON l.logistics_request_id = lr.id WHERE l.id = $1 AND lr.deleted_at IS NULL`,
    [z.uuid({ error: "Transport leg not found" }).parse(id)],
  );
  if (!rows.length) throw new HttpError(404, "Transport leg not found");
  return rows[0];
}

const update = wrap(async (req, res) => {
  const request = await legRequest(req.params.id);
  const p = patchBody.parse(req.body);
  const sets = [];
  const vals = [req.params.id];
  for (const [key, column] of Object.entries(COLUMNS)) {
    if (p[key] === undefined) continue;
    vals.push(p[key] ?? null);
    sets.push(`${column} = $${vals.length}`);
  }
  if (!sets.length) throw new HttpError(400, "Nothing to update");
  await assertSupplier(p.supplierId);
  const cur = (await query(`SELECT depart_date::text AS d, arrive_date::text AS a FROM transport_legs WHERE id = $1`, [req.params.id])).rows[0];
  checkDates(p.departDate ?? cur.d, p.arriveDate === undefined ? cur.a : p.arriveDate);
  await query(`UPDATE transport_legs SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
  res.json({ data: await loadTransport(request) });
});

const remove = wrap(async (req, res) => {
  const request = await legRequest(req.params.id);
  await query(`DELETE FROM transport_legs WHERE id = $1`, [req.params.id]);
  res.json({ data: await loadTransport(request) });
});

/** An empty list means everyone on the request travels on this leg. */
const setPassengers = wrap(async (req, res) => {
  const request = await legRequest(req.params.id);
  const { travellerIds } = z.object({ travellerIds: z.array(z.uuid()).max(500) }).parse(req.body);
  const ids = [...new Set(travellerIds)];
  if (ids.length) {
    const { rows } = await query(`SELECT id FROM request_travellers WHERE logistics_request_id = $1 AND id = ANY($2::uuid[])`, [request.id, ids]);
    if (rows.length !== ids.length) throw new HttpError(400, "Some travellers aren't on this request");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM transport_passengers WHERE leg_id = $1`, [req.params.id]);
    if (ids.length)
      await client.query(`INSERT INTO transport_passengers (leg_id, traveller_id) SELECT $1, unnest($2::uuid[])`, [req.params.id, ids]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  res.json({ data: await loadTransport(request) });
});

const confirmAll = wrap(async (req, res) => {
  const request = await requestByReference(req.params.reference);
  const done = await query(
    `UPDATE transport_legs SET status = 'confirmed', updated_at = now() WHERE logistics_request_id = $1 AND status = 'planned'`,
    [request.id],
  );
  if (!done.rowCount) throw new HttpError(409, "There are no planned transport legs to confirm");
  await query(
    `INSERT INTO request_events (logistics_request_id, actor_account_id, actor_role, action, note)
     VALUES ($1,$2,'manager','transport_confirmed',$3)`,
    [request.id, req.user.id, `${done.rowCount} transport leg${done.rowCount === 1 ? "" : "s"} confirmed`],
  );
  res.json({ data: await loadTransport(request) });
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

const pdf = wrap(async (req, res) => {
  const request = await requestByReference(req.params.reference);
  const team = await query(`SELECT tp.name FROM logistics_requests lr LEFT JOIN team_profiles tp ON tp.id = lr.team_profile_id WHERE lr.id = $1`, [request.id]);
  const { renderTransport } = require("./transport.pdf");
  sendPdf(res, await renderTransport(await loadTransport(request), { teamName: team.rows[0]?.name, draft: true }), `transport-${request.reference}.pdf`);
});

module.exports = { get, create, update, remove, setPassengers, confirmAll, pdf, loadTransport, sendPdf };
