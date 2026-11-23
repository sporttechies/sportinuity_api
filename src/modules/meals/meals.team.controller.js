// Team side: confirmed meals and the team's own dietary summary, read-only.
const { query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");
const { loadMeals, sendPdf } = require("./meals.controller");
const { renderMealPlan } = require("./meals.pdf");

async function teamRequest(req) {
  const { rows } = await query(
    `SELECT lr.id, lr.reference, lr.event_name, lr.destination, lr.traveller_count,
            lr.departure_date::text AS departure_date, lr.return_date::text AS return_date, tp.name AS team_name
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
    const plan = await loadMeals(request, { confirmedOnly: true });
    res.json({ data: { ...plan, meals: plan.meals.map(({ notes, ...m }) => m) } });
  } catch (error) {
    next(error);
  }
}

async function pdf(req, res, next) {
  try {
    const request = await teamRequest(req);
    const plan = await loadMeals(request, { confirmedOnly: true });
    if (!plan.meals.length) throw new HttpError(404, "The meal plan isn't ready yet");
    sendPdf(res, await renderMealPlan({ ...plan, meals: plan.meals.map((m) => ({ ...m, notes: null })) }, { teamName: request.team_name }), `meals-${request.reference}.pdf`);
  } catch (error) {
    next(error);
  }
}

module.exports = { get, pdf };
