// Team side: confirmed transport legs, read-only (no internal notes or suppliers).
const { query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");
const { loadTransport, sendPdf } = require("./transport.controller");
const { renderTransport } = require("./transport.pdf");

async function teamRequest(req) {
  const { rows } = await query(
    `SELECT lr.id, lr.reference, lr.event_name, lr.origin, lr.destination, tp.name AS team_name
       FROM logistics_requests lr JOIN team_profiles tp ON tp.id = lr.team_profile_id
      WHERE lr.reference = $1 AND lr.team_profile_id = $2 AND lr.deleted_at IS NULL`,
    [String(req.params.reference).toUpperCase(), req.user.teamProfileId],
  );
  if (!rows.length) throw new HttpError(404, "Request not found");
  return rows[0];
}

async function get(req, res, next) {
  try {
    const request = await teamRequest(req);
    const plan = await loadTransport(request, { confirmedOnly: true, forTeam: true });
    res.json({ data: { ...plan, travellers: undefined } });
  } catch (error) {
    next(error);
  }
}

async function pdf(req, res, next) {
  try {
    const request = await teamRequest(req);
    const plan = await loadTransport(request, { confirmedOnly: true, forTeam: true });
    if (!plan.legs.length) throw new HttpError(404, "The transport plan isn't ready yet");
    sendPdf(res, await renderTransport(plan, { teamName: request.team_name }), `transport-${request.reference}.pdf`);
  } catch (error) {
    next(error);
  }
}

module.exports = { get, pdf };
