const { query } = require("../../config/db");
async function findTeamAdminByEmail(email) {
  const { rows } = await query(
    `SELECT a.id, a.email, a.password_hash, a.display_name AS name, a.account_status, tap.team_profile_id, tp.name AS team_name FROM auth_accounts a JOIN team_admin_profiles tap ON tap.auth_account_id = a.id JOIN team_profiles tp ON tp.id = tap.team_profile_id WHERE lower(a.email) = lower($1) AND a.account_type = 'team_admin'`,
    [email],
  );
  return rows[0];
}
async function findManagerByEmail(email) {
  const { rows } = await query(
    `SELECT id, email, password_hash, display_name AS name, account_status FROM auth_accounts WHERE lower(email) = lower($1) AND account_type = 'manager'`,
    [email],
  );
  return rows[0];
}
async function findAccountById(id) {
  const { rows } = await query(
    `SELECT id, email, display_name AS name, account_type, account_status FROM auth_accounts WHERE id = $1`,
    [id],
  );
  return rows[0];
}
async function createTeamAdmin({ teamName, name, email, passwordHash }) {
  const client = await require("../../config/db").pool.connect();
  try {
    await client.query("BEGIN");
    const team = await client.query(
      `INSERT INTO team_profiles (name, sport, country, city) VALUES ($1, 'Multi-sport', 'ZA', 'Johannesburg') RETURNING id, name`,
      [teamName],
    );
    const account = await client.query(
      `INSERT INTO auth_accounts (email, display_name, password_hash, account_type) VALUES ($1,$2,$3,'team_admin') RETURNING id,email,display_name AS name`,
      [email, name, passwordHash],
    );
    await client.query(
      `INSERT INTO team_admin_profiles (auth_account_id, team_profile_id, full_name) VALUES ($1,$2,$3)`,
      [account.rows[0].id, team.rows[0].id, name],
    );
    await client.query("COMMIT");
    return {
      ...account.rows[0],
      team_profile_id: team.rows[0].id,
      team_name: team.rows[0].name,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
module.exports = {
  findTeamAdminByEmail,
  findManagerByEmail,
  findAccountById,
  createTeamAdmin,
};
