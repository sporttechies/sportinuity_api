// Staff assignments: which managers handle a request, and in what role.
const { z } = require("zod");
const { pool, query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");
const notify = require("../../shared/mail/notify");

const ROLES = ["lead", "support", "finance", "on_site"];
const assignBody = z.object({
  managerId: z.uuid({ error: "Choose a staff member" }),
  role: z.enum(ROLES, { error: "Choose a role" }).default("support"),
  note: z.preprocess((v) => (v === "" ? null : v), z.string().trim().max(300).nullable().optional()),
});

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

async function requestByReference(reference) {
  const { rows } = await query(
    `SELECT id, reference, event_name, team_name FROM logistics_requests WHERE reference = $1 AND deleted_at IS NULL`,
    [String(reference).toUpperCase()],
  );
  if (!rows.length) throw new HttpError(404, "Request not found");
  return rows[0];
}

async function listFor(requestId) {
  const { rows } = await query(
    `SELECT ra.id, ra.manager_account_id, ra.role, ra.note, ra.created_at, a.display_name AS name, a.email
       FROM request_assignments ra JOIN auth_accounts a ON a.id = ra.manager_account_id
      WHERE ra.logistics_request_id = $1
      ORDER BY (ra.role = 'lead') DESC, ra.created_at`,
    [requestId],
  );
  return rows.map((r) => ({
    id: r.id, managerId: r.manager_account_id, name: r.name, email: r.email, role: r.role, note: r.note, createdAt: r.created_at,
  }));
}

const event = (client, requestId, user, action, note) =>
  client.query(
    `INSERT INTO request_events (logistics_request_id, actor_account_id, actor_role, action, note) VALUES ($1,$2,'manager',$3,$4)`,
    [requestId, user.id, action, note],
  );

const staff = wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.display_name AS name, a.email,
            (SELECT count(*)::int FROM request_assignments ra JOIN logistics_requests lr ON lr.id = ra.logistics_request_id
              WHERE ra.manager_account_id = a.id AND lr.deleted_at IS NULL
                AND lr.status NOT IN ('completed','cancelled','rejected')) AS open_requests
       FROM auth_accounts a WHERE a.account_type = 'manager' AND a.account_status = 'active' ORDER BY a.display_name`,
  );
  res.json({ data: rows.map((r) => ({ id: r.id, name: r.name, email: r.email, openRequests: r.open_requests })) });
});

const list = wrap(async (req, res) => {
  const request = await requestByReference(req.params.reference);
  res.json({ data: await listFor(request.id) });
});

/** Adds a person, or changes their role if already assigned. A new lead replaces the old one (who becomes support). */
const assign = wrap(async (req, res) => {
  const request = await requestByReference(req.params.reference);
  const b = assignBody.parse(req.body);
  const person = await query(
    `SELECT display_name, email FROM auth_accounts WHERE id = $1 AND account_type = 'manager' AND account_status = 'active'`,
    [b.managerId],
  );
  if (!person.rows.length) throw new HttpError(400, "That staff member isn't available");
  const client = await pool.connect();
  let changed = false;
  try {
    await client.query("BEGIN");
    if (b.role === "lead")
      await client.query(
        `UPDATE request_assignments SET role = 'support' WHERE logistics_request_id = $1 AND role = 'lead' AND manager_account_id <> $2`,
        [request.id, b.managerId],
      );
    const before = await client.query(
      `SELECT role, note FROM request_assignments WHERE logistics_request_id = $1 AND manager_account_id = $2`,
      [request.id, b.managerId],
    );
    changed = !before.rows.length || before.rows[0].role !== b.role;
    await client.query(
      `INSERT INTO request_assignments (logistics_request_id, manager_account_id, role, note, assigned_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (logistics_request_id, manager_account_id) DO UPDATE SET role = EXCLUDED.role, note = EXCLUDED.note`,
      [request.id, b.managerId, b.role, b.note ?? null, req.user.id],
    );
    if (changed) await event(client, request.id, req.user, "staff_assigned", `${person.rows[0].display_name} as ${b.role.replace("_", " ")}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  if (changed && b.managerId !== req.user.id)
    notify.staffAssigned(request, { to: person.rows[0].email, name: person.rows[0].display_name, role: b.role, note: b.note, by: req.user.name });
  res.status(201).json({ data: await listFor(request.id) });
});

const unassign = wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT ra.id, ra.logistics_request_id, a.display_name FROM request_assignments ra JOIN auth_accounts a ON a.id = ra.manager_account_id
      WHERE ra.id = $1`,
    [z.uuid({ error: "Assignment not found" }).parse(req.params.id)],
  );
  if (!rows.length) throw new HttpError(404, "Assignment not found");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM request_assignments WHERE id = $1`, [rows[0].id]);
    await event(client, rows[0].logistics_request_id, req.user, "staff_unassigned", `${rows[0].display_name} removed`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  res.json({ data: await listFor(rows[0].logistics_request_id) });
});

module.exports = { staff, list, assign, unassign };
