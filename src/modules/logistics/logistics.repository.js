const { pool, query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");

// Dates are cast to text so JSON always carries plain YYYY-MM-DD strings.
const COLUMNS = `
  lr.id, lr.reference, lr.request_type, lr.team_profile_id,
  COALESCE(tp.name, lr.team_name) AS team_name,
  tp.sport AS team_sport, tp.country AS team_country,
  tp.logo_updated_at AS team_logo_updated_at, tp.logo_url AS team_logo_url,
  lr.event_name, lr.origin, lr.destination,
  lr.departure_date::text AS departure_date, lr.return_date::text AS return_date,
  lr.traveller_count, lr.status, lr.rejection_reason, lr.manager_notes,
  lr.contact_name, lr.contact_email, lr.contact_phone,
  lr.created_at, lr.updated_at, lr.reviewed_at`;
const FROM_SQL = `FROM logistics_requests lr LEFT JOIN team_profiles tp ON tp.id = lr.team_profile_id`;

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

function buildFilters(options) {
  const where = ["lr.deleted_at IS NULL"];
  const values = [];
  const add = (sql, value) => {
    values.push(value);
    where.push(sql.replaceAll("?", `$${values.length}`));
  };
  if (options.teamProfileId)
    add("lr.team_profile_id = ?", options.teamProfileId);
  if (options.status) {
    const statuses = String(options.status).split(",").filter(Boolean);
    if (statuses.length) add("lr.status = ANY(?::text[])", statuses);
  }
  if (options.q) {
    add(
      `(lr.reference ILIKE ? OR lr.event_name ILIKE ? OR lr.destination ILIKE ?
        OR lr.origin ILIKE ? OR lr.contact_name ILIKE ? OR COALESCE(tp.name, lr.team_name) ILIKE ?)`,
      `%${escapeLike(String(options.q).trim())}%`,
    );
  }
  if (options.dateTo) add("lr.departure_date <= ?::date", options.dateTo);
  if (options.dateFrom)
    add(
      "COALESCE(lr.return_date, lr.departure_date) >= ?::date",
      options.dateFrom,
    );
  return { where: where.join(" AND "), values };
}

async function listRequests(options = {}) {
  const { where, values } = buildFilters(options);
  const limit = Math.min(Math.max(Number(options.limit) || 25, 1), 500);
  const offset = Math.max(Number(options.offset) || 0, 0);
  const [list, count] = await Promise.all([
    query(
      `SELECT ${COLUMNS} ${FROM_SQL} WHERE ${where}
        ORDER BY lr.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      values,
    ),
    query(`SELECT count(*)::int AS total ${FROM_SQL} WHERE ${where}`, values),
  ]);
  return { rows: list.rows, total: count.rows[0].total, limit, offset };
}

async function statusCounts(teamProfileId) {
  const { rows } = await query(
    `SELECT status, count(*)::int AS n FROM logistics_requests
      WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR team_profile_id = $1)
      GROUP BY status`,
    [teamProfileId || null],
  );
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

async function findByReference(reference, { teamProfileId } = {}) {
  const values = [String(reference).toUpperCase()];
  let scope = "";
  if (teamProfileId) {
    values.push(teamProfileId);
    scope = " AND lr.team_profile_id = $2";
  }
  const { rows } = await query(
    `SELECT ${COLUMNS} ${FROM_SQL}
      WHERE lr.reference = $1 AND lr.deleted_at IS NULL${scope}`,
    values,
  );
  const row = rows[0];
  if (!row) return null;
  const [travellers, events] = await Promise.all([
    query(
      `SELECT id, traveller_index, category, first_name, last_name, traveller_type,
              document_number, dietary_needs
         FROM request_travellers WHERE logistics_request_id = $1 ORDER BY traveller_index`,
      [row.id],
    ),
    query(
      `SELECT e.id, e.action, e.actor_role, e.from_status, e.to_status, e.note,
              e.created_at, a.display_name AS actor_name
         FROM request_events e LEFT JOIN auth_accounts a ON a.id = e.actor_account_id
        WHERE e.logistics_request_id = $1 ORDER BY e.created_at DESC`,
      [row.id],
    ),
  ]);
  return { ...row, travellers: travellers.rows, events: events.rows };
}

async function addEvent(
  client,
  { requestId, actor, action, fromStatus, toStatus, note },
) {
  await client.query(
    `INSERT INTO request_events
       (logistics_request_id, actor_account_id, actor_role, action, from_status, to_status, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      requestId,
      actor?.id || null,
      actor?.role || null,
      action,
      fromStatus || null,
      toStatus || null,
      note || null,
    ],
  );
}

async function insertTravellers(client, requestId, teamProfileId, travellers) {
  if (!travellers.length) return;
  const values = [];
  const rows = travellers.map((t, index) => {
    const base = values.length;
    values.push(
      requestId,
      teamProfileId,
      index,
      t.category || "adult",
      t.firstName.trim(),
      t.lastName.trim(),
      t.type || "regular",
      t.documentNumber?.trim() || null,
      t.dietary?.trim() || null,
    );
    return `(${Array.from({ length: 9 }, (_, i) => `$${base + i + 1}`).join(",")})`;
  });
  await client.query(
    `INSERT INTO request_travellers
       (logistics_request_id, team_profile_id, traveller_index, category,
        first_name, last_name, traveller_type, document_number, dietary_needs)
     VALUES ${rows.join(",")}`,
    values,
  );
}

function assertDates(departure, returnDate) {
  if (departure && returnDate && returnDate < departure)
    throw new HttpError(
      400,
      "The return date cannot be before the departure date",
    );
}

async function insertRequest(input) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const team = await client.query(
      `SELECT name FROM team_profiles WHERE id = $1`,
      [input.teamProfileId],
    );
    if (!team.rows[0]) throw new HttpError(404, "Team not found");
    const { rows } = await client.query(
      `INSERT INTO logistics_requests
         (reference, request_type, team_profile_id, team_name, event_name, origin, destination,
          departure_date, return_date, traveller_count, contact_name, contact_email,
          contact_phone, created_by_team_admin_id, status)
       VALUES ('SL-' || nextval('public.request_reference_seq')::text, 'team',
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'new')
       RETURNING id, reference`,
      [
        input.teamProfileId,
        team.rows[0].name,
        input.event,
        input.from || null,
        input.location,
        input.departure || null,
        input.returnDate || null,
        input.travellers.length,
        input.contact?.name || null,
        input.contact?.email || null,
        input.contact?.phone || null,
        input.createdByTeamAdminId || null,
      ],
    );
    await insertTravellers(
      client,
      rows[0].id,
      input.teamProfileId,
      input.travellers,
    );
    await addEvent(client, {
      requestId: rows[0].id,
      actor: input.actor,
      action: "created",
      toStatus: "new",
    });
    await client.query("COMMIT");
    return rows[0].reference;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Reference numbers come from a sequence; retry in the unlikely case an old
// request already uses the next number.
async function createRequest(input) {
  assertDates(input.departure, input.returnDate);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await insertRequest(input);
    } catch (error) {
      if (error.code === "23505" && /reference/.test(error.constraint || ""))
        continue;
      throw error;
    }
  }
  throw new HttpError(500, "Could not generate a reference, please try again");
}

async function updateRequest(reference, patch, actor) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT id, team_profile_id, departure_date::text AS departure_date,
              return_date::text AS return_date
         FROM logistics_requests
        WHERE reference = $1 AND deleted_at IS NULL FOR UPDATE`,
      [String(reference).toUpperCase()],
    );
    const row = found.rows[0];
    if (!row) throw new HttpError(404, "Request not found");
    if (patch.travellers && !row.team_profile_id)
      throw new HttpError(
        409,
        "This older request has no team, so its travellers cannot be edited",
      );

    const sets = [];
    const values = [row.id];
    const set = (column, value) => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (patch.event !== undefined) set("event_name", patch.event);
    if (patch.from !== undefined) set("origin", patch.from || null);
    if (patch.location !== undefined) set("destination", patch.location);
    if (patch.departure !== undefined)
      set("departure_date", patch.departure || null);
    if (patch.returnDate !== undefined)
      set("return_date", patch.returnDate || null);
    if (patch.managerNotes !== undefined)
      set("manager_notes", patch.managerNotes || null);
    if (patch.contact) {
      if (patch.contact.name !== undefined)
        set("contact_name", patch.contact.name || null);
      if (patch.contact.email !== undefined)
        set("contact_email", patch.contact.email || null);
      if (patch.contact.phone !== undefined)
        set("contact_phone", patch.contact.phone || null);
    }
    if (patch.travellers) set("traveller_count", patch.travellers.length);

    assertDates(
      patch.departure !== undefined
        ? patch.departure || null
        : row.departure_date,
      patch.returnDate !== undefined
        ? patch.returnDate || null
        : row.return_date,
    );

    if (sets.length) {
      await client.query(
        `UPDATE logistics_requests SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
        values,
      );
    }
    if (patch.travellers) {
      await client.query(
        `DELETE FROM request_travellers WHERE logistics_request_id = $1`,
        [row.id],
      );
      await insertTravellers(
        client,
        row.id,
        row.team_profile_id,
        patch.travellers,
      );
    }
    await addEvent(client, {
      requestId: row.id,
      actor,
      action: "edited",
      note: Object.keys(patch).join(", "),
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// `canMove(from, to)` decides whether the transition is allowed for the caller.
async function changeStatus({
  reference,
  teamProfileId,
  to,
  reason,
  actor,
  canMove,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const values = [String(reference).toUpperCase()];
    let scope = "";
    if (teamProfileId) {
      values.push(teamProfileId);
      scope = " AND team_profile_id = $2";
    }
    const found = await client.query(
      `SELECT id, status FROM logistics_requests
        WHERE reference = $1 AND deleted_at IS NULL${scope} FOR UPDATE`,
      values,
    );
    const current = found.rows[0];
    if (!current) throw new HttpError(404, "Request not found");
    if (current.status === to)
      throw new HttpError(
        409,
        `This request is already ${to.replace("_", " ")}`,
      );
    if (!canMove(current.status, to))
      throw new HttpError(
        409,
        `A ${current.status.replace("_", " ")} request cannot be moved to ${to.replace("_", " ")}`,
      );
    const isManager = actor.role === "manager";
    await client.query(
      `UPDATE logistics_requests
          SET status = $2,
              rejection_reason = $3,
              reviewed_by = CASE WHEN $4 THEN $5::uuid ELSE reviewed_by END,
              reviewed_at = CASE WHEN $4 THEN now() ELSE reviewed_at END,
              updated_at = now()
        WHERE id = $1`,
      [
        current.id,
        to,
        to === "rejected" ? reason || null : null,
        isManager,
        actor.id,
      ],
    );
    await addEvent(client, {
      requestId: current.id,
      actor,
      action: "status_changed",
      fromStatus: current.status,
      toStatus: to,
      note: reason,
    });
    await client.query("COMMIT");
    return { previous: current.status };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function softDelete(reference, actor) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `UPDATE logistics_requests SET deleted_at = now(), updated_at = now()
        WHERE reference = $1 AND deleted_at IS NULL RETURNING id, status`,
      [String(reference).toUpperCase()],
    );
    if (!found.rows[0]) throw new HttpError(404, "Request not found");
    await addEvent(client, {
      requestId: found.rows[0].id,
      actor,
      action: "deleted",
      fromStatus: found.rows[0].status,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function dashboard() {
  const [counts, travellers, teams, recent, upcoming] = await Promise.all([
    statusCounts(),
    query(
      `SELECT COALESCE(sum(traveller_count), 0)::int AS n FROM logistics_requests
        WHERE deleted_at IS NULL AND status IN ('new','in_review','quoted','confirmed')`,
    ),
    query(`SELECT count(*)::int AS n FROM team_profiles`),
    query(
      `SELECT ${COLUMNS} ${FROM_SQL} WHERE lr.deleted_at IS NULL
        ORDER BY lr.created_at DESC LIMIT 6`,
    ),
    query(
      `SELECT ${COLUMNS} ${FROM_SQL}
        WHERE lr.deleted_at IS NULL AND lr.status IN ('new','in_review','quoted','confirmed')
          AND lr.departure_date >= CURRENT_DATE
        ORDER BY lr.departure_date ASC LIMIT 5`,
    ),
  ]);
  return {
    byStatus: counts,
    travellers: travellers.rows[0].n,
    teams: teams.rows[0].n,
    recent: recent.rows,
    upcoming: upcoming.rows,
  };
}

module.exports = {
  listRequests,
  statusCounts,
  findByReference,
  createRequest,
  updateRequest,
  changeStatus,
  softDelete,
  dashboard,
};
