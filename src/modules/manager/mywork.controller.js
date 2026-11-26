// "My work": what the signed-in manager should act on today.
const { query } = require("../../config/db");

const OPEN = `lr.status NOT IN ('completed','cancelled','rejected') AND lr.deleted_at IS NULL`;

/** Turns counts into short, ordered to-do items. Pure, so it is easy to test. */
function buildTodos(r) {
  const todos = [];
  const add = (kind, label, anchor) => todos.push({ kind, label, anchor });
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (r.status === "new") add("review", "New request: needs a first review", "top");
  if (r.status === "in_review") add("review", "In review: send a quote or decision", "quotations");
  if (r.unread > 0) add("messages", `${plural(r.unread, "unread message")} from the team`, "messages");
  if (r.quotes_received > 0) add("quotes", `${plural(r.quotes_received, "quote")} to accept or reject`, "quotations");
  if (r.quotes_requested > 0) add("quotes", `Waiting on ${plural(r.quotes_requested, "supplier quote")}`, "quotations");
  if (r.status === "confirmed") {
    if (r.rooming !== "final") add("rooming", r.rooming === "draft" ? "Rooming list is still a draft" : "Rooming list not started", "rooming");
    if (r.meals_total === 0) add("meals", "No meals planned yet", "meals");
    else if (r.meals_planned > 0) add("meals", `${plural(r.meals_planned, "meal")} not confirmed`, "meals");
    if (r.legs_total === 0) add("transport", "No transport planned yet", "transport");
    else if (r.legs_planned > 0) add("transport", `${plural(r.legs_planned, "transport leg")} not confirmed`, "transport");
  }
  return todos;
}

async function myWork(req, res, next) {
  try {
    const me = req.user.id;
    const { rows } = await query(
      `SELECT lr.reference, lr.team_name, lr.event_name, lr.destination, lr.status, lr.traveller_count,
              lr.departure_date::text AS departure_date, (lr.departure_date - current_date) AS days_to_departure,
              ra.role,
              (SELECT count(*)::int FROM request_messages m WHERE m.logistics_request_id = lr.id AND m.sender_role = 'team_admin' AND m.read_at IS NULL) AS unread,
              (SELECT count(*)::int FROM quotations q WHERE q.logistics_request_id = lr.id AND q.status = 'received') AS quotes_received,
              (SELECT count(*)::int FROM quotations q WHERE q.logistics_request_id = lr.id AND q.status = 'requested') AS quotes_requested,
              COALESCE((SELECT CASE WHEN rl.status = 'final' THEN 'final'
                                    WHEN EXISTS (SELECT 1 FROM rooms rm WHERE rm.logistics_request_id = lr.id) THEN 'draft' ELSE 'none' END
                          FROM rooming_lists rl WHERE rl.logistics_request_id = lr.id), 'none') AS rooming,
              (SELECT count(*)::int FROM meals ml WHERE ml.logistics_request_id = lr.id) AS meals_total,
              (SELECT count(*)::int FROM meals ml WHERE ml.logistics_request_id = lr.id AND ml.status = 'planned') AS meals_planned,
              (SELECT count(*)::int FROM transport_legs tl WHERE tl.logistics_request_id = lr.id) AS legs_total,
              (SELECT count(*)::int FROM transport_legs tl WHERE tl.logistics_request_id = lr.id AND tl.status = 'planned') AS legs_planned
         FROM request_assignments ra JOIN logistics_requests lr ON lr.id = ra.logistics_request_id
        WHERE ra.manager_account_id = $1 AND ${OPEN}`,
      [me],
    );

    const items = rows
      .map((r) => {
        const todos = buildTodos(r);
        const days = r.days_to_departure === null ? null : Number(r.days_to_departure);
        return {
          reference: r.reference,
          team: r.team_name,
          event: r.event_name,
          destination: r.destination,
          status: r.status,
          travellers: r.traveller_count,
          role: r.role,
          departureDate: r.departure_date,
          daysToDeparture: days,
          unread: r.unread,
          todos,
        };
      })
      .sort((a, b) => {
        const urgent = (x) => (x.unread > 0 ? 0 : x.todos.length ? 1 : 2);
        return (
          urgent(a) - urgent(b) ||
          (a.daysToDeparture ?? 9999) - (b.daysToDeparture ?? 9999) ||
          a.reference.localeCompare(b.reference)
        );
      });

    const unassigned = await query(
      `SELECT lr.reference, lr.team_name, lr.event_name, lr.status, lr.created_at, lr.departure_date::text AS departure_date
         FROM logistics_requests lr
        WHERE ${OPEN} AND NOT EXISTS (SELECT 1 FROM request_assignments x WHERE x.logistics_request_id = lr.id)
        ORDER BY lr.created_at DESC LIMIT 8`,
    );
    const unassignedCount = await query(
      `SELECT count(*)::int AS n FROM logistics_requests lr
        WHERE ${OPEN} AND NOT EXISTS (SELECT 1 FROM request_assignments x WHERE x.logistics_request_id = lr.id)`,
    );
    const rosters = await query(`SELECT count(*)::int AS n FROM team_profiles WHERE roster_status = 'submitted'`);

    res.json({
      data: {
        summary: {
          assigned: items.length,
          needAction: items.filter((i) => i.todos.length).length,
          unreadMessages: items.reduce((n, i) => n + i.unread, 0),
          departingSoon: items.filter((i) => i.daysToDeparture !== null && i.daysToDeparture >= 0 && i.daysToDeparture <= 14).length,
          unassigned: unassignedCount.rows[0].n,
          rostersToReview: rosters.rows[0].n,
        },
        items,
        unassigned: unassigned.rows.map((r) => ({
          reference: r.reference,
          team: r.team_name,
          event: r.event_name,
          status: r.status,
          departureDate: r.departure_date,
          createdAt: r.created_at,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = { myWork, buildTodos };
