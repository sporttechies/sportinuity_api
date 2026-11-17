const { pool, query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");

const TEAM_COLUMNS = `t.id, t.name, t.sport, t.country, t.city, t.logo_updated_at, t.logo_url,
  t.created_at, t.updated_at, t.edition_id, e.name AS edition_name, t.age_category,
  t.coach_name, t.coach_email, t.coach_phone, t.roster_consent_at, t.roster_submitted_at`;

async function getTeam(teamId) {
  const { rows } = await query(
    `SELECT ${TEAM_COLUMNS}
       FROM team_profiles t
       LEFT JOIN tournament_editions e ON e.id = t.edition_id
      WHERE t.id = $1`,
    [teamId],
  );
  return rows[0];
}

async function getAdmins(teamId) {
  const { rows } = await query(
    `SELECT tap.id, a.id AS account_id, a.email, a.display_name AS name,
            a.account_status, tap.created_at
       FROM team_admin_profiles tap
       JOIN auth_accounts a ON a.id = tap.auth_account_id
      WHERE tap.team_profile_id = $1 ORDER BY tap.created_at`,
    [teamId],
  );
  return rows;
}

// patch.logo: undefined = leave, null = remove, { url } = replace.
async function updateTeam(teamId, patch) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (patch.name !== undefined) {
      const clash = await client.query(
        `SELECT 1 FROM team_profiles WHERE lower(name) = lower($1) AND id <> $2`,
        [patch.name, teamId],
      );
      if (clash.rows.length)
        throw new HttpError(409, "A team with this name is already registered");
    }
    const sets = [];
    const values = [teamId];
    const set = (sql, value) => {
      values.push(value);
      sets.push(sql.replace("?", `$${values.length}`));
    };
    if (patch.name !== undefined) set("name = ?", patch.name);
    if (patch.sport !== undefined) set("sport = ?", patch.sport);
    if (patch.country !== undefined) set("country = ?", patch.country);
    if (patch.city !== undefined) set("city = ?", patch.city || null);
    if (patch.editionId !== undefined) set("edition_id = ?", patch.editionId);
    if (patch.ageCategory !== undefined) set("age_category = ?", patch.ageCategory);
    if (patch.coachName !== undefined) set("coach_name = ?", patch.coachName);
    if (patch.coachEmail !== undefined) set("coach_email = ?", patch.coachEmail);
    if (patch.coachPhone !== undefined) set("coach_phone = ?", patch.coachPhone);
    if (patch.logo === null) {
      sets.push("logo_data = NULL", "logo_mime = NULL", "logo_url = NULL", "logo_updated_at = NULL");
    } else if (patch.logo) {
      // patch.logo = { url }: the image is already on Cloudinary.
      set("logo_url = ?", patch.logo.url);
      sets.push("logo_data = NULL", "logo_mime = NULL", "logo_updated_at = now()");
    }
    if (sets.length) {
      const result = await client.query(
        `UPDATE team_profiles SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
        values,
      );
      if (!result.rowCount) throw new HttpError(404, "Team not found");
    }
    if (patch.adminAccountId && patch.adminName !== undefined) {
      await client.query(
        `UPDATE auth_accounts SET display_name = $2, updated_at = now() WHERE id = $1`,
        [patch.adminAccountId, patch.adminName],
      );
      await client.query(
        `UPDATE team_admin_profiles SET full_name = $2 WHERE auth_account_id = $1`,
        [patch.adminAccountId, patch.adminName],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getLogo(teamId) {
  const { rows } = await query(
    `SELECT logo_data, logo_mime, logo_updated_at FROM team_profiles
      WHERE id = $1 AND logo_data IS NOT NULL`,
    [teamId],
  );
  return rows[0];
}

async function getDraft(teamAdminId) {
  const { rows } = await query(
    `SELECT payload, updated_at FROM request_drafts WHERE team_admin_profile_id = $1`,
    [teamAdminId],
  );
  return rows[0];
}

async function saveDraft(teamAdminId, teamProfileId, payload) {
  const { rows } = await query(
    `INSERT INTO request_drafts (team_admin_profile_id, team_profile_id, payload)
     VALUES ($1, $2, $3)
     ON CONFLICT (team_admin_profile_id)
     DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
     RETURNING updated_at`,
    [teamAdminId, teamProfileId, JSON.stringify(payload)],
  );
  return rows[0];
}

async function deleteDraft(teamAdminId) {
  await query(`DELETE FROM request_drafts WHERE team_admin_profile_id = $1`, [teamAdminId]);
}

module.exports = {
  getTeam,
  getAdmins,
  updateTeam,
  getLogo,
  getDraft,
  saveDraft,
  deleteDraft,
};
