// Message thread between a team and the managers on one request.
// "Unread" for the manager = team messages the managers haven't opened yet, and the reverse.
const { z } = require("zod");
const { query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");
const notify = require("../../shared/mail/notify");

const bodySchema = z.object({
  body: z.string().trim().min(1, "Write a message first").max(2000, "Keep messages under 2000 characters"),
});

const REQUEST_SQL = `SELECT lr.id, lr.reference, lr.event_name, lr.team_name AS request_team_name, lr.team_profile_id,
       lr.contact_email, tp.name AS team_name
  FROM logistics_requests lr LEFT JOIN team_profiles tp ON tp.id = lr.team_profile_id`;

async function managerRequest(reference) {
  const { rows } = await query(`${REQUEST_SQL} WHERE lr.reference = $1 AND lr.deleted_at IS NULL`, [String(reference).toUpperCase()]);
  if (!rows.length) throw new HttpError(404, "Request not found");
  return rows[0];
}

async function teamRequest(req) {
  const { rows } = await query(`${REQUEST_SQL} WHERE lr.reference = $1 AND lr.team_profile_id = $2 AND lr.deleted_at IS NULL`, [
    String(req.params.reference).toUpperCase(),
    req.user.teamProfileId,
  ]);
  if (!rows.length) throw new HttpError(404, "Request not found");
  return rows[0];
}

/** viewer: 'manager' | 'team_admin'. Opening the thread marks the other side's messages as read. */
async function loadThread(request, viewer) {
  const other = viewer === "manager" ? "team_admin" : "manager";
  await query(
    `UPDATE request_messages SET read_at = now() WHERE logistics_request_id = $1 AND sender_role = $2 AND read_at IS NULL`,
    [request.id, other],
  );
  const { rows } = await query(
    `SELECT id, sender_role, sender_name, body, read_at, created_at FROM request_messages
      WHERE logistics_request_id = $1 ORDER BY created_at, id`,
    [request.id],
  );
  return {
    reference: request.reference,
    messages: rows.map((m) => ({
      id: m.id,
      from: m.sender_role === "manager" ? "manager" : "team",
      mine: m.sender_role === viewer,
      // Teams see "Sportinuity team", not the individual manager's name.
      senderName: m.sender_role === "manager" && viewer !== "manager" ? "Sportinuity team" : m.sender_name,
      body: m.body,
      read: Boolean(m.read_at),
      createdAt: m.created_at,
    })),
  };
}

async function post(request, user, role, text) {
  // Only email when this starts a new burst, so a flurry of messages isn't a flurry of emails.
  const recent = await query(
    `SELECT 1 FROM request_messages WHERE logistics_request_id = $1 AND sender_role = $2 AND read_at IS NULL
        AND created_at > now() - interval '10 minutes' LIMIT 1`,
    [request.id, role],
  );
  const { rows } = await query(
    `INSERT INTO request_messages (logistics_request_id, sender_role, sender_account_id, sender_name, body)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [request.id, role, user.id, user.name || (role === "manager" ? "Sportinuity" : "Team"), text],
  );
  if (!recent.rows.length) notify.messagePosted(request, { body: text, byTeam: role === "team_admin", senderName: user.name });
  return rows[0].id;
}

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

const currentUser = async (req) => ({ id: req.user.id, name: req.user.name });

// ---- manager
const managerGet = wrap(async (req, res) => {
  res.json({ data: await loadThread(await managerRequest(req.params.reference), "manager") });
});
const managerPost = wrap(async (req, res) => {
  const request = await managerRequest(req.params.reference);
  await post(request, await currentUser(req), "manager", bodySchema.parse(req.body).body);
  res.status(201).json({ data: await loadThread(request, "manager") });
});

// ---- team
const teamGet = wrap(async (req, res) => {
  res.json({ data: await loadThread(await teamRequest(req), "team_admin") });
});
const teamPost = wrap(async (req, res) => {
  const request = await teamRequest(req);
  await post(request, await currentUser(req), "team_admin", bodySchema.parse(req.body).body);
  res.status(201).json({ data: await loadThread(request, "team_admin") });
});

// ---- unread summaries
async function unread(forRole, teamProfileId) {
  const from = forRole === "manager" ? "team_admin" : "manager";
  const { rows } = await query(
    `SELECT lr.reference, count(*)::int AS count, max(m.created_at) AS latest
       FROM request_messages m JOIN logistics_requests lr ON lr.id = m.logistics_request_id
      WHERE m.sender_role = $1 AND m.read_at IS NULL AND lr.deleted_at IS NULL
        AND ($2::uuid IS NULL OR lr.team_profile_id = $2)
      GROUP BY lr.reference ORDER BY latest DESC`,
    [from, teamProfileId ?? null],
  );
  return { data: rows.map(({ reference, count }) => ({ reference, count })), total: rows.reduce((n, r) => n + r.count, 0) };
}
const managerUnread = wrap(async (req, res) => res.json(await unread("manager", null)));
const teamUnread = wrap(async (req, res) => res.json(await unread("team_admin", req.user.teamProfileId)));

module.exports = { managerGet, managerPost, teamGet, teamPost, managerUnread, teamUnread };
