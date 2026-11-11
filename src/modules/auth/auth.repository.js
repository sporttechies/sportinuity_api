const { pool, query } = require("../../config/db");

async function findTeamAdminByEmail(email) {
  const { rows } = await query(
    `SELECT a.id, a.email, a.password_hash, a.display_name AS name, a.account_status,
            tap.team_profile_id, tp.name AS team_name, tp.logo_updated_at, tp.logo_url
       FROM auth_accounts a
       JOIN team_admin_profiles tap ON tap.auth_account_id = a.id
       JOIN team_profiles tp ON tp.id = tap.team_profile_id
      WHERE lower(a.email) = lower($1) AND a.account_type = 'team_admin'`,
    [email],
  );
  return rows[0];
}

async function findManagerByEmail(email) {
  const { rows } = await query(
    `SELECT id, email, password_hash, display_name AS name, account_status
       FROM auth_accounts
      WHERE lower(email) = lower($1) AND account_type = 'manager'`,
    [email],
  );
  return rows[0];
}

async function emailInUse(email) {
  const { rows } = await query(
    `SELECT 1 FROM auth_accounts WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows.length > 0;
}

async function teamNameInUse(name) {
  const { rows } = await query(
    `SELECT 1 FROM team_profiles WHERE lower(name) = lower($1)`,
    [name],
  );
  return rows.length > 0;
}

async function createTeamAdmin({
  teamName,
  name,
  email,
  passwordHash,
  sport,
  country,
  city,
}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const team = await client.query(
      `INSERT INTO team_profiles (name, sport, country, city)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, sport, country, city, logo_updated_at, logo_url`,
      [teamName, sport, country, city || null],
    );
    const account = await client.query(
      `INSERT INTO auth_accounts (email, display_name, password_hash, account_type)
       VALUES ($1, $2, $3, 'team_admin')
       RETURNING id, email, display_name AS name`,
      [email, name, passwordHash],
    );
    await client.query(
      `INSERT INTO team_admin_profiles (auth_account_id, team_profile_id, full_name)
       VALUES ($1, $2, $3)`,
      [account.rows[0].id, team.rows[0].id, name],
    );
    await client.query("COMMIT");
    return {
      ...account.rows[0],
      team_profile_id: team.rows[0].id,
      team_name: team.rows[0].name,
      logo_updated_at: null,
      logo_url: null,
      team: team.rows[0],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function getPasswordHash(accountId) {
  const { rows } = await query(
    `SELECT password_hash FROM auth_accounts WHERE id = $1`,
    [accountId],
  );
  return rows[0]?.password_hash;
}

async function setPasswordHash(accountId, passwordHash) {
  await query(
    `UPDATE auth_accounts SET password_hash = $2, updated_at = now() WHERE id = $1`,
    [accountId, passwordHash],
  );
}

module.exports = {
  findTeamAdminByEmail,
  findManagerByEmail,
  emailInUse,
  teamNameInUse,
  createTeamAdmin,
  getPasswordHash,
  setPasswordHash,
};
