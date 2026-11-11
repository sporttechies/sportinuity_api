const { pool, query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");

const escapeLike = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

async function listTeams(q) {
  const pattern = q ? `%${escapeLike(String(q).trim())}%` : null;
  const { rows } = await query(
    `SELECT tp.id, tp.name, tp.sport, tp.country, tp.city, tp.logo_updated_at, tp.logo_url,
            tp.created_at, tp.updated_at,
            adm.name AS admin_name, adm.email AS admin_email,
            adm.account_status,
            (SELECT count(*)::int FROM logistics_requests lr
              WHERE lr.team_profile_id = tp.id AND lr.deleted_at IS NULL) AS request_count,
            (SELECT count(*)::int FROM logistics_requests lr
              WHERE lr.team_profile_id = tp.id AND lr.deleted_at IS NULL
                AND lr.status IN ('new','in_review')) AS pending_count
       FROM team_profiles tp
       LEFT JOIN LATERAL (
         SELECT a.display_name AS name, a.email, a.account_status
           FROM team_admin_profiles tap
           JOIN auth_accounts a ON a.id = tap.auth_account_id
          WHERE tap.team_profile_id = tp.id
          ORDER BY tap.created_at LIMIT 1
       ) adm ON true
      WHERE ($1::text IS NULL OR tp.name ILIKE $1 OR tp.sport ILIKE $1
             OR tp.country ILIKE $1 OR tp.city ILIKE $1 OR adm.email ILIKE $1)
      ORDER BY tp.created_at DESC`,
    [pattern],
  );
  return rows;
}

async function setTeamAccountStatus(teamId, status) {
  const result = await query(
    `UPDATE auth_accounts SET account_status = $2, updated_at = now()
      WHERE id IN (SELECT auth_account_id FROM team_admin_profiles WHERE team_profile_id = $1)`,
    [teamId, status],
  );
  return result.rowCount;
}

// A team that has ever made a request cannot be deleted (history must stay
// intact) - disable its accounts instead.
async function deleteTeam(teamId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const team = await client.query(`SELECT id FROM team_profiles WHERE id = $1 FOR UPDATE`, [teamId]);
    if (!team.rows[0]) throw new HttpError(404, "Team not found");
    const used = await client.query(
      `SELECT 1 FROM logistics_requests WHERE team_profile_id = $1 LIMIT 1`,
      [teamId],
    );
    if (used.rows.length)
      throw new HttpError(
        409,
        "This team has requests on record and cannot be deleted. Disable its account instead.",
      );
    const admins = await client.query(
      `SELECT auth_account_id FROM team_admin_profiles WHERE team_profile_id = $1`,
      [teamId],
    );
    await client.query(`DELETE FROM team_admin_profiles WHERE team_profile_id = $1`, [teamId]);
    const accountIds = admins.rows.map((row) => row.auth_account_id);
    if (accountIds.length)
      await client.query(`DELETE FROM auth_accounts WHERE id = ANY($1::uuid[])`, [accountIds]);
    await client.query(`DELETE FROM team_profiles WHERE id = $1`, [teamId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateManagerName(accountId, name) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE auth_accounts SET display_name = $2, updated_at = now() WHERE id = $1`,
      [accountId, name],
    );
    await client.query(`UPDATE manager_profiles SET full_name = $2 WHERE auth_account_id = $1`, [
      accountId,
      name,
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { listTeams, setTeamAccountStatus, deleteTeam, updateManagerName };
