// Tournament editions: managers create them and open/close registration;
// the public site lists the open ones in the registration form.
const { z } = require("zod");
const { query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");
const { TEAM_SPORT_LIMITS, AGE_CATEGORIES } = require("../../shared/constants");

const body = z.object({
  name: z.string().trim().min(2).max(120),
  isOpen: z.boolean().optional(),
});
const serialize = (r) => ({
  id: r.id,
  name: r.name,
  isOpen: r.is_open,
  teams: r.teams ?? 0,
  createdAt: r.created_at,
});

// Public: everything the registration form needs.
async function options(_req, res, next) {
  try {
    const { rows } = await query(
      `SELECT id, name, is_open, created_at FROM tournament_editions
        WHERE is_open ORDER BY created_at DESC`,
    );
    res.json({
      data: {
        editions: rows.map(serialize),
        ageCategories: AGE_CATEGORIES,
        teamSports: TEAM_SPORT_LIMITS,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function list(_req, res, next) {
  try {
    const { rows } = await query(
      `SELECT e.id, e.name, e.is_open, e.created_at,
              (SELECT count(*)::int FROM team_profiles t WHERE t.edition_id = e.id) AS teams
         FROM tournament_editions e ORDER BY e.created_at DESC`,
    );
    res.json({ data: rows.map(serialize) });
  } catch (error) {
    next(error);
  }
}

async function create(req, res, next) {
  try {
    const input = body.parse(req.body);
    const { rows } = await query(
      `INSERT INTO tournament_editions (name, is_open) VALUES ($1, $2)
       RETURNING id, name, is_open, created_at`,
      [input.name, input.isOpen ?? true],
    );
    res.status(201).json({ data: serialize(rows[0]) });
  } catch (error) {
    next(error.code === "23505" ? new HttpError(409, "An edition with this name already exists") : error);
  }
}

async function update(req, res, next) {
  try {
    const id = z.uuid().parse(req.params.id);
    const input = body.partial().parse(req.body);
    const { rows } = await query(
      `UPDATE tournament_editions
          SET name = COALESCE($2, name), is_open = COALESCE($3, is_open)
        WHERE id = $1 RETURNING id, name, is_open, created_at`,
      [id, input.name ?? null, input.isOpen ?? null],
    );
    if (!rows.length) throw new HttpError(404, "Edition not found");
    res.json({ data: serialize(rows[0]) });
  } catch (error) {
    next(error.code === "23505" ? new HttpError(409, "An edition with this name already exists") : error);
  }
}

// Teams that picked it simply lose the edition (ON DELETE SET NULL).
async function remove(req, res, next) {
  try {
    const id = z.uuid().parse(req.params.id);
    const result = await query(`DELETE FROM tournament_editions WHERE id = $1`, [id]);
    if (!result.rowCount) throw new HttpError(404, "Edition not found");
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

module.exports = { options, list, create, update, remove };
