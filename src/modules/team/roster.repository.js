const { query } = require("../../config/db");

const COLUMNS = `id, team_profile_id, full_name,
  to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
  jersey_number, position, photo_url, (document_data IS NOT NULL) AS has_document,
  created_at, updated_at`;

async function listPlayers(teamId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM team_players WHERE team_profile_id = $1 ORDER BY created_at, id`,
    [teamId],
  );
  return rows;
}

async function countPlayers(teamId) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM team_players WHERE team_profile_id = $1`,
    [teamId],
  );
  return rows[0].n;
}

async function getPlayer(teamId, playerId) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM team_players WHERE id = $1 AND team_profile_id = $2`,
    [playerId, teamId],
  );
  return rows[0];
}

async function newPlayerId() {
  const { rows } = await query(`SELECT gen_random_uuid() AS id`);
  return rows[0].id;
}

async function insertPlayer(teamId, id, p) {
  await query(
    `INSERT INTO team_players
       (id, team_profile_id, full_name, date_of_birth, jersey_number, position,
        photo_url, document_data, document_mime)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, teamId, p.fullName, p.dateOfBirth, p.jerseyNumber, p.position,
     p.photoUrl, p.document?.buffer ?? null, p.document?.mime ?? null],
  );
}

async function updatePlayer(teamId, id, p) {
  const sets = [];
  const values = [id, teamId];
  const set = (sql, value) => {
    values.push(value);
    sets.push(sql.replace("?", `$${values.length}`));
  };
  if (p.fullName !== undefined) set("full_name = ?", p.fullName);
  if (p.dateOfBirth !== undefined) set("date_of_birth = ?", p.dateOfBirth);
  if (p.jerseyNumber !== undefined) set("jersey_number = ?", p.jerseyNumber);
  if (p.position !== undefined) set("position = ?", p.position);
  if (p.photoUrl) set("photo_url = ?", p.photoUrl);
  if (p.document) {
    set("document_data = ?", p.document.buffer);
    set("document_mime = ?", p.document.mime);
  }
  if (!sets.length) return true;
  const result = await query(
    `UPDATE team_players SET ${sets.join(", ")}, updated_at = now()
      WHERE id = $1 AND team_profile_id = $2`,
    values,
  );
  return result.rowCount > 0;
}

async function deletePlayer(teamId, id) {
  const result = await query(
    `DELETE FROM team_players WHERE id = $1 AND team_profile_id = $2`,
    [id, teamId],
  );
  return result.rowCount > 0;
}

async function getDocument(teamId, id) {
  const { rows } = await query(
    `SELECT document_data, document_mime FROM team_players
      WHERE id = $1 AND team_profile_id = $2 AND document_data IS NOT NULL`,
    [id, teamId],
  );
  return rows[0];
}

async function submitRoster(teamId) {
  await query(
    `UPDATE team_profiles
        SET roster_consent_at = now(), roster_submitted_at = now(), updated_at = now(),
            roster_status = 'submitted', roster_review_note = NULL
      WHERE id = $1`,
    [teamId],
  );
}

// A squad that changes after submission has to be submitted (and reviewed) again.
async function markEdited(teamId) {
  await query(
    `UPDATE team_profiles SET roster_status = 'draft', updated_at = now()
      WHERE id = $1 AND roster_status IN ('submitted','approved')`,
    [teamId],
  );
}

async function setReview(teamId, { status, note, reviewerId }) {
  const { rows } = await query(
    `UPDATE team_profiles
        SET roster_status = $2, roster_review_note = $3, roster_reviewed_at = now(), roster_reviewed_by = $4, updated_at = now()
      WHERE id = $1 AND roster_status = 'submitted' RETURNING id`,
    [teamId, status, note, reviewerId],
  );
  return rows.length > 0;
}

module.exports = {
  markEdited, setReview,
  listPlayers, countPlayers, getPlayer, newPlayerId, insertPlayer,
  updatePlayer, deletePlayer, getDocument, submitRoster,
};
