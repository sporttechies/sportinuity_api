// Rooming lists (manager side): rooms, who sleeps where, suggestions, finalising.
const { z } = require("zod");
const { pool, query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");
const { suggestRooms, capacityOf } = require("./rooming.suggest");

const ROOM_TYPES = ["single", "double", "twin", "triple", "quad", "custom"];
const blank = (v) => (v === "" ? null : v);

const roomBody = z.object({
  roomType: z.enum(ROOM_TYPES, { error: "Choose a room type" }),
  capacity: z.preprocess((v) => (v === "" || v == null ? undefined : Number(v)), z.number().int().min(1).max(10).optional()),
  label: z.preprocess(blank, z.string().trim().max(60).nullable().optional()),
  notes: z.preprocess(blank, z.string().trim().max(500).nullable().optional()),
});

async function requestByReference(reference) {
  const { rows } = await query(
    `SELECT id, reference, status, event_name, origin, destination,
            departure_date::text AS departure_date, return_date::text AS return_date
       FROM logistics_requests WHERE reference = $1 AND deleted_at IS NULL`,
    [String(reference).toUpperCase()],
  );
  if (!rows.length) throw new HttpError(404, "Request not found");
  return rows[0];
}

const serializeTraveller = (t) => ({
  id: t.id,
  index: t.traveller_index,
  category: t.category,
  firstName: t.first_name,
  lastName: t.last_name,
  type: t.traveller_type,
  dietary: t.dietary_needs,
});

/** The whole rooming list for a request, shaped for both managers and teams. */
async function inOrder(tasks) {
  const out = [];
  for (const task of tasks) out.push(await task());
  return out;
}

async function loadList(request, client = { query }) {
  // Sequential: inside a transaction all queries share one connection.
  const [list, rooms, assignments, travellers, proposals, hotel] = await inOrder([
    () => client.query(`SELECT status, notes, finalized_at FROM rooming_lists WHERE logistics_request_id = $1`, [request.id]),
    () => client.query(
      `SELECT id, label, room_type, capacity, notes FROM rooms
        WHERE logistics_request_id = $1 ORDER BY sort_order, created_at, id`,
      [request.id],
    ),
    () => client.query(
      `SELECT ra.room_id, ra.traveller_id FROM room_assignments ra
         JOIN rooms r ON r.id = ra.room_id WHERE r.logistics_request_id = $1`,
      [request.id],
    ),
    () => client.query(
      `SELECT id, traveller_index, category, first_name, last_name, traveller_type, dietary_needs
         FROM request_travellers WHERE logistics_request_id = $1 ORDER BY traveller_index`,
      [request.id],
    ),
    () => client.query(
      `SELECT id, room_type, traveller_ids, note FROM roommate_requests
        WHERE logistics_request_id = $1 ORDER BY created_at`,
      [request.id],
    ),
    () => client.query(
      `SELECT s.name, q.description FROM quotations q JOIN suppliers s ON s.id = q.supplier_id
        WHERE q.logistics_request_id = $1 AND q.service_type = 'accommodation' AND q.status = 'accepted'
        LIMIT 1`,
      [request.id],
    ),
  ]);
  const byId = new Map(travellers.rows.map((t) => [t.id, serializeTraveller(t)]));
  const placed = new Map(assignments.rows.map((a) => [a.traveller_id, a.room_id]));
  const roomList = rooms.rows.map((r) => ({
    id: r.id,
    label: r.label,
    roomType: r.room_type,
    capacity: r.capacity,
    notes: r.notes,
    occupants: assignments.rows
      .filter((a) => a.room_id === r.id)
      .map((a) => byId.get(a.traveller_id))
      .filter(Boolean)
      .sort((a, b) => a.index - b.index),
  }));
  const row = list.rows[0];
  return {
    reference: request.reference,
    event: request.event_name,
    destination: request.destination,
    checkIn: request.departure_date,
    checkOut: request.return_date,
    status: row?.status ?? "draft",
    finalizedAt: row?.finalized_at ?? null,
    notes: row?.notes ?? null,
    hotel: hotel.rows[0] ? { name: hotel.rows[0].name, description: hotel.rows[0].description } : null,
    rooms: roomList,
    unassigned: [...byId.values()].filter((t) => !placed.has(t.id)),
    proposals: proposals.rows.map((p) => ({
      id: p.id,
      roomType: p.room_type,
      travellerIds: p.traveller_ids,
      note: p.note,
    })),
    travellerCount: byId.size,
  };
}

async function ensureList(client, requestId) {
  await client.query(
    `INSERT INTO rooming_lists (logistics_request_id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [requestId],
  );
}

async function assertEditable(client, requestId) {
  const { rows } = await client.query(`SELECT status FROM rooming_lists WHERE logistics_request_id = $1`, [requestId]);
  if (rows[0]?.status === "final")
    throw new HttpError(409, "The rooming list is final. Reopen it to make changes.");
}

/** Runs `fn(client, request)` in a transaction, then returns the fresh list. */
async function withList(req, res, next, getRequest, fn, status = 200) {
  const client = await pool.connect();
  try {
    const request = await getRequest(client);
    await client.query("BEGIN");
    await ensureList(client, request.id);
    await fn(client, request);
    await client.query("COMMIT");
    const data = await loadList(request);
    res.status(status).json({ data });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
}

const byReference = (req) => async () => requestByReference(req.params.reference);
const byRoom = (req) => async (client) => {
  const id = z.uuid().parse(req.params.id);
  const { rows } = await client.query(
    `SELECT lr.id, lr.reference, lr.event_name, lr.origin, lr.destination,
            lr.departure_date::text AS departure_date, lr.return_date::text AS return_date,
            lr.status
       FROM rooms r JOIN logistics_requests lr ON lr.id = r.logistics_request_id
      WHERE r.id = $1 AND lr.deleted_at IS NULL`,
    [id],
  );
  if (!rows.length) throw new HttpError(404, "Room not found");
  return rows[0];
};

async function get(req, res, next) {
  try {
    const request = await requestByReference(req.params.reference);
    res.json({ data: await loadList(request) });
  } catch (error) {
    next(error);
  }
}

async function insertRoom(client, requestId, { roomType, capacity, label, notes }, number) {
  const cap = capacityOf(roomType, capacity);
  await client.query(
    `INSERT INTO rooms (logistics_request_id, label, room_type, capacity, notes, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [requestId, label || `Room ${number}`, roomType, cap, notes ?? null, number],
  );
}

async function createRooms(req, res, next) {
  const body = roomBody.extend({ count: z.coerce.number().int().min(1).max(50).default(1) });
  return withList(req, res, next, byReference(req), async (client, request) => {
    const i = body.parse(req.body);
    await assertEditable(client, request.id);
    const existing = (await client.query(`SELECT count(*)::int AS n FROM rooms WHERE logistics_request_id = $1`, [request.id])).rows[0].n;
    if (existing + i.count > 300) throw new HttpError(400, "Too many rooms");
    for (let k = 0; k < i.count; k++)
      await insertRoom(client, request.id, { ...i, label: i.count === 1 ? i.label : null }, existing + k + 1);
  }, 201);
}

async function updateRoom(req, res, next) {
  return withList(req, res, next, byRoom(req), async (client, request) => {
    const i = roomBody.partial().parse(req.body);
    await assertEditable(client, request.id);
    const id = req.params.id;
    const current = (await client.query(`SELECT room_type, capacity FROM rooms WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    const type = i.roomType ?? current.room_type;
    const capacity = capacityOf(type, i.capacity ?? (type === "custom" ? current.capacity : undefined));
    const occupants = (await client.query(`SELECT count(*)::int AS n FROM room_assignments WHERE room_id = $1`, [id])).rows[0].n;
    if (occupants > capacity)
      throw new HttpError(409, `This room has ${occupants} guests; move some out before shrinking it`);
    await client.query(
      `UPDATE rooms SET room_type = $2, capacity = $3,
              label = COALESCE($4, label), notes = CASE WHEN $5::boolean THEN $6 ELSE notes END,
              updated_at = now()
        WHERE id = $1`,
      [id, type, capacity, i.label ?? null, i.notes !== undefined, i.notes ?? null],
    );
  });
}

async function deleteRoom(req, res, next) {
  return withList(req, res, next, byRoom(req), async (client, request) => {
    await assertEditable(client, request.id);
    await client.query(`DELETE FROM rooms WHERE id = $1`, [req.params.id]); // guests become unassigned
  });
}

const occupantsBody = z.object({ travellerIds: z.array(z.uuid()).max(10) });

async function setOccupants(req, res, next) {
  return withList(req, res, next, byRoom(req), async (client, request) => {
    const { travellerIds } = occupantsBody.parse(req.body);
    await assertEditable(client, request.id);
    const ids = [...new Set(travellerIds)];
    const room = (await client.query(`SELECT capacity FROM rooms WHERE id = $1 FOR UPDATE`, [req.params.id])).rows[0];
    if (ids.length > room.capacity)
      throw new HttpError(409, `This room only fits ${room.capacity}`);
    if (ids.length) {
      const valid = await client.query(
        `SELECT id FROM request_travellers WHERE logistics_request_id = $1 AND id = ANY($2::uuid[])`,
        [request.id, ids],
      );
      if (valid.rows.length !== ids.length) throw new HttpError(400, "Some travellers aren't on this request");
    }
    // Moving someone here takes them out of their previous room.
    await client.query(`DELETE FROM room_assignments WHERE traveller_id = ANY($1::uuid[])`, [ids]);
    await client.query(`DELETE FROM room_assignments WHERE room_id = $1`, [req.params.id]);
    for (const id of ids)
      await client.query(`INSERT INTO room_assignments (room_id, traveller_id) VALUES ($1,$2)`, [req.params.id, id]);
  });
}

const suggestBody = z.object({
  roomType: z.enum(ROOM_TYPES).default("twin"),
  vipSingle: z.boolean().default(true),
  capacity: z.coerce.number().int().min(1).max(10).optional(),
});

async function suggest(req, res, next) {
  return withList(req, res, next, byReference(req), async (client, request) => {
    const o = suggestBody.parse(req.body ?? {});
    await assertEditable(client, request.id);
    const list = await loadList(request, client);
    if (!list.unassigned.length) throw new HttpError(400, "Everyone already has a room");
    const free = list.unassigned.map((t) => ({ id: t.id, category: t.category, type: t.type, index: t.index }));
    const rooms = suggestRooms(free, list.proposals, { roomType: o.roomType === "custom" ? "twin" : o.roomType, vipSingle: o.vipSingle });
    let number = list.rooms.length;
    for (const room of rooms) {
      number += 1;
      const r = await client.query(
        `INSERT INTO rooms (logistics_request_id, label, room_type, capacity, sort_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [request.id, `Room ${number}`, room.roomType, room.capacity, number],
      );
      for (const id of room.travellerIds)
        await client.query(`INSERT INTO room_assignments (room_id, traveller_id) VALUES ($1,$2)`, [r.rows[0].id, id]);
    }
  });
}

// Removes every room (guests become unassigned) so the list can be started again.
async function clear(req, res, next) {
  return withList(req, res, next, byReference(req), async (client, request) => {
    await assertEditable(client, request.id);
    await client.query(`DELETE FROM rooms WHERE logistics_request_id = $1`, [request.id]);
  });
}

async function updateNotes(req, res, next) {
  const body = z.object({ notes: z.preprocess(blank, z.string().trim().max(2000).nullable()) });
  return withList(req, res, next, byReference(req), async (client, request) => {
    const { notes } = body.parse(req.body);
    await client.query(`UPDATE rooming_lists SET notes = $2, updated_at = now() WHERE logistics_request_id = $1`, [request.id, notes]);
  });
}

async function finalize(req, res, next) {
  const body = z.object({ force: z.boolean().optional() });
  return withList(req, res, next, byReference(req), async (client, request) => {
    const { force } = body.parse(req.body ?? {});
    const list = await loadList(request, client);
    if (list.status === "final") throw new HttpError(409, "Already final");
    if (!list.rooms.length) throw new HttpError(400, "Add rooms before finalising");
    if (list.unassigned.length && !force)
      throw new HttpError(409, `${list.unassigned.length} traveller(s) have no room yet`);
    await client.query(
      `UPDATE rooming_lists SET status = 'final', finalized_at = now(), updated_at = now() WHERE logistics_request_id = $1`,
      [request.id],
    );
    await client.query(
      `INSERT INTO request_events (logistics_request_id, actor_account_id, actor_role, action, note)
       VALUES ($1,$2,'manager','rooming_finalised',$3)`,
      [request.id, req.user.id, `Rooming list finalised (${list.rooms.length} rooms)`],
    );
  });
}

async function reopen(req, res, next) {
  return withList(req, res, next, byReference(req), async (client, request) => {
    const { rows } = await client.query(`SELECT status FROM rooming_lists WHERE logistics_request_id = $1`, [request.id]);
    if (rows[0]?.status !== "final") throw new HttpError(409, "The list isn't final");
    await client.query(
      `UPDATE rooming_lists SET status = 'draft', finalized_at = NULL, updated_at = now() WHERE logistics_request_id = $1`,
      [request.id],
    );
  });
}

module.exports = {
  get, createRooms, updateRoom, deleteRoom, setOccupants, suggest, clear, updateNotes,
  finalize, reopen, loadList, requestByReference,
};
