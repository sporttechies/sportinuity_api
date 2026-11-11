const { z } = require("zod");
const repository = require("./manager.repository");
const teamRepository = require("../team/team.repository");
const logistics = require("../logistics/logistics.repository");
const { serializeRequest } = require("../logistics/logistics.serializer");
const { serializeTeam } = require("../team/team.controller");
const { HttpError } = require("../../shared/http-error");
const { logoPath } = require("../../shared/team-logo");
const { storeLogo } = require("../../shared/store-logo");
const { SPORTS } = require("../../shared/constants");

const teamPatch = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  sport: z.enum(SPORTS).optional(),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  city: z.string().trim().max(120).nullish(),
  logo: z.string().max(450_000).nullable().optional(),
});

async function dashboard(_req, res, next) {
  try {
    const d = await logistics.dashboard();
    const by = d.byStatus;
    const n = (status) => by[status] || 0;
    res.json({
      data: {
        byStatus: by,
        totals: {
          requests: Object.values(by).reduce((a, b) => a + b, 0),
          active: n("new") + n("in_review") + n("quoted") + n("confirmed"),
          awaitingAction: n("new") + n("in_review"),
          confirmed: n("confirmed"),
          travellers: d.travellers,
          teams: d.teams,
        },
        recent: d.recent.map((row) => serializeRequest(row)),
        upcoming: d.upcoming.map((row) => serializeRequest(row)),
      },
    });
  } catch (error) {
    next(error);
  }
}

async function listTeams(req, res, next) {
  try {
    const rows = await repository.listTeams(req.query.q);
    res.json({
      data: rows.map((row) => ({
        id: row.id,
        name: row.name,
        sport: row.sport,
        country: row.country,
        city: row.city,
        logoPath: logoPath(row.id, row.logo_updated_at, row.logo_url),
        createdAt: row.created_at,
        adminName: row.admin_name,
        adminEmail: row.admin_email,
        accountStatus: row.account_status || "active",
        requestCount: row.request_count,
        pendingCount: row.pending_count,
      })),
    });
  } catch (error) {
    next(error);
  }
}

async function getTeam(req, res, next) {
  try {
    const id = z.uuid().parse(req.params.id);
    const team = await teamRepository.getTeam(id);
    if (!team) throw new HttpError(404, "Team not found");
    const [admins, requests, counts] = await Promise.all([
      teamRepository.getAdmins(id),
      logistics.listRequests({ teamProfileId: id, limit: 100 }),
      logistics.statusCounts(id),
    ]);
    res.json({
      data: {
        ...serializeTeam(team),
        admins: admins.map((a) => ({
          id: a.account_id,
          name: a.name,
          email: a.email,
          accountStatus: a.account_status,
        })),
        requestCounts: counts,
        requests: requests.rows.map((row) => serializeRequest(row)),
      },
    });
  } catch (error) {
    next(error);
  }
}

async function updateTeam(req, res, next) {
  try {
    const id = z.uuid().parse(req.params.id);
    const input = teamPatch.parse(req.body);
    const patch = { ...input, logo: await storeLogo(id, input.logo) };
    await teamRepository.updateTeam(id, patch);
    req.params.id = id;
    return getTeam(req, res, next);
  } catch (error) {
    next(error);
  }
}

async function setTeamStatus(req, res, next) {
  try {
    const id = z.uuid().parse(req.params.id);
    const { status } = z.object({ status: z.enum(["active", "disabled"]) }).parse(req.body);
    if (!(await teamRepository.getTeam(id))) throw new HttpError(404, "Team not found");
    await repository.setTeamAccountStatus(id, status);
    req.params.id = id;
    return getTeam(req, res, next);
  } catch (error) {
    next(error);
  }
}

async function deleteTeam(req, res, next) {
  try {
    await repository.deleteTeam(z.uuid().parse(req.params.id));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

async function updateMe(req, res, next) {
  try {
    const { fullName } = z
      .object({ fullName: z.string().trim().min(2).max(120) })
      .parse(req.body);
    await repository.updateManagerName(req.user.id, fullName);
    res.json({
      user: { id: req.user.id, email: req.user.email, name: fullName, role: "manager" },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  dashboard,
  listTeams,
  getTeam,
  updateTeam,
  setTeamStatus,
  deleteTeam,
  updateMe,
};
