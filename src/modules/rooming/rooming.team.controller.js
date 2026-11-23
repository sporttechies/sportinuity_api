// Team side of rooming: propose who shares a room, and read the final list.
// Rooms stay hidden from the team until the manager finalises the list.
const { z } = require("zod");
const { pool, query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");
const { loadList } = require("./rooming.controller");
const { renderRoomingList } = require("./rooming.pdf");

const ROOM_TYPES = ["single", "double", "twin", "triple", "quad", "custom"];
const blank = (v) => (v === "" ? null : v);

async function teamRequest(req) {
  const { rows } = await query(
    `SELECT lr.id, lr.reference, lr.status, lr.event_name, lr.origin, lr.destination,
            lr.departure_date::text AS departure_date, lr.return_date::text AS return_date,
            tp.name AS team_name
       FROM logistics_requests lr JOIN team_profiles tp ON tp.id = lr.team_profile_id
      WHERE lr.reference = $1 AND lr.team_profile_id = $2 AND lr.deleted_at IS NULL`,
    [String(req.params.reference).toUpperCase(), req.user.teamProfileId],
  );
  if (!rows.length) throw new HttpError(404, "Request not found");
  return rows[0];
}

const closed = (status) => ["cancelled", "rejected", "completed"].includes(status);

function teamView(list, request) {
  const final = list.status === "final";
  const people = [...list.unassigned, ...list.rooms.flatMap((r) => r.occupants)].sort((a, b) => a.index - b.index);
  return {
    reference: list.reference,
    status: list.status,
    finalizedAt: list.finalizedAt,
    canPropose: !final && !closed(request.status),
    checkIn: list.checkIn,
    checkOut: list.checkOut,
    travellers: people.map(({ id, index, category, firstName, lastName, type }) => ({
      id, index, category, firstName, lastName, type,
    })),
    proposals: list.proposals,
    hotel: final ? list.hotel : null,
    rooms: final ? list.rooms : [],
    unassigned: final ? list.unassigned : [],
  };
}

async function get(req, res, next) {
  try {
    const request = await teamRequest(req);
    res.json({ data: teamView(await loadList(request), request) });
  } catch (error) {
    next(error);
  }
}

const body = z.object({
  groups: z
    .array(
      z.object({
        travellerIds: z.array(z.uuid()).min(1).max(10),
        roomType: z.preprocess(blank, z.enum(ROOM_TYPES).nullable().optional()),
        note: z.preprocess(blank, z.string().trim().max(300).nullable().optional()),
      }),
    )
    .max(60),
});

// Replaces the team's whole set of proposals.
async function saveRoommates(req, res, next) {
  const client = await pool.connect();
  try {
    const request = await teamRequest(req);
    const { groups } = body.parse(req.body);
    if (closed(request.status)) throw new HttpError(409, `This request is ${request.status}`);
    const current = await loadList(request);
    if (current.status === "final")
      throw new HttpError(409, "The rooming list is final. Contact us to change it.");

    const everyone = new Set([...current.unassigned, ...current.rooms.flatMap((r) => r.occupants)].map((t) => t.id));
    const seen = new Set();
    for (const g of groups) {
      const ids = [...new Set(g.travellerIds)];
      if (ids.length !== g.travellerIds.length) throw new HttpError(400, "A traveller is listed twice in one group");
      if (ids.length < 2 && g.roomType !== "single")
        throw new HttpError(400, "A group needs at least two people (or ask for a single room)");
      for (const id of ids) {
        if (!everyone.has(id)) throw new HttpError(400, "Some travellers aren't on this request");
        if (seen.has(id)) throw new HttpError(400, "A traveller can only be in one group");
        seen.add(id);
      }
    }
    await client.query("BEGIN");
    await client.query(`DELETE FROM roommate_requests WHERE logistics_request_id = $1`, [request.id]);
    for (const g of groups)
      await client.query(
        `INSERT INTO roommate_requests (logistics_request_id, room_type, traveller_ids, note)
         VALUES ($1,$2,$3::uuid[],$4)`,
        [request.id, g.roomType ?? null, [...new Set(g.travellerIds)], g.note ?? null],
      );
    await client.query(
      `INSERT INTO rooming_lists (logistics_request_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [request.id],
    );
    await client.query("COMMIT");
    res.json({ data: teamView(await loadList(request), request) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
}

async function pdf(req, res, next) {
  try {
    const request = await teamRequest(req);
    const list = await loadList(request);
    if (list.status !== "final") throw new HttpError(404, "The rooming list isn't ready yet");
    const buffer = await renderRoomingList(list, { teamName: request.team_name });
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="rooming-${list.reference}.pdf"`,
      "Cache-Control": "private, no-store",
      "Content-Length": buffer.length,
    });
    res.send(buffer);
  } catch (error) {
    next(error);
  }
}

module.exports = { get, saveRoommates, pdf };
