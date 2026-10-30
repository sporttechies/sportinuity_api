const { pool, query } = require("../../config/db");

const columns = `lr.id, lr.reference, lr.request_type, lr.team_profile_id, lr.team_name, lr.event_name, lr.destination, lr.origin, lr.departure_date, lr.return_date, lr.traveller_count, lr.status, lr.contact_name, lr.contact_email, lr.contact_phone, lr.created_at`;
async function hydrate(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((row) => row.id);
  const { rows: travellers } = await query(
    `SELECT * FROM request_travellers WHERE logistics_request_id = ANY($1::uuid[]) ORDER BY traveller_index`,
    [ids],
  );
  return rows.map((row) => ({
    ...row,
    travellers: travellers.filter(
      (traveller) => traveller.logistics_request_id === row.id,
    ),
  }));
}
async function listRequests() {
  const { rows } = await query(
    `SELECT ${columns}, tp.name AS joined_team_name FROM logistics_requests lr LEFT JOIN team_profiles tp ON tp.id = lr.team_profile_id ORDER BY lr.created_at DESC`,
  );
  return hydrate(
    rows.map((row) => ({
      ...row,
      team_name: row.team_name || row.joined_team_name,
    })),
  );
}
async function findByReference(reference) {
  const { rows } = await query(
    `SELECT ${columns}, tp.name AS joined_team_name FROM logistics_requests lr LEFT JOIN team_profiles tp ON tp.id = lr.team_profile_id WHERE lr.reference = $1`,
    [reference],
  );
  return (
    await hydrate(
      rows.map((row) => ({
        ...row,
        team_name: row.team_name || row.joined_team_name,
      })),
    )
  )[0];
}
async function createRequest(input) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO logistics_requests (reference, request_type, team_name, event_name, destination, origin, departure_date, return_date, traveller_count, contact_name, contact_email, contact_phone, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'new') RETURNING id, reference, request_type, team_name, event_name, destination, origin, departure_date, return_date, traveller_count, status, contact_name, contact_email, contact_phone, created_at`,
      [
        input.reference,
        input.requestType,
        input.team,
        input.event,
        input.destination,
        input.origin || null,
        input.departure || null,
        input.returnDate || null,
        input.people,
        input.contact?.name || null,
        input.contact?.email || null,
        input.contact?.phone || null,
      ],
    );
    const request = rows[0];
    for (const [index, traveller] of (input.travellers || []).entries())
      await client.query(
        `INSERT INTO request_travellers (logistics_request_id, traveller_index, category, first_name, last_name, traveller_type, document_number, dietary_needs) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          request.id,
          index,
          traveller.category || (index < input.adults ? "adult" : "child"),
          traveller.firstName,
          traveller.lastName,
          traveller.type || "regular",
          traveller.documentNumber || null,
          traveller.dietary || null,
        ],
      );
    await client.query("COMMIT");
    return { ...request, travellers: input.travellers || [] };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
module.exports = { listRequests, findByReference, createRequest };
