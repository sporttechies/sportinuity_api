// Everything a logged-in team admin can do. Every query is scoped to
// req.user.teamProfileId, so a team can never see or touch another team's data.
const { z } = require("zod");
const repository = require("./team.repository");
const logistics = require("../logistics/logistics.repository");
const schemas = require("../logistics/logistics.schemas");
const { serializeRequest } = require("../logistics/logistics.serializer");
const notify = require("../../shared/mail/notify");
const { HttpError } = require("../../shared/http-error");
const { logoPath } = require("../../shared/team-logo");
const { storeLogo } = require("../../shared/store-logo");
const { SPORTS, TEAM_CANCELLABLE } = require("../../shared/constants");

const actorOf = (req) => ({ id: req.user.id, role: "team_admin" });

const profileBody = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  sport: z.enum(SPORTS, { error: "Choose a sport" }).optional(),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Choose a country")
    .optional(),
  city: z.string().trim().max(120).nullish(),
  adminName: z.string().trim().min(2).max(120).optional(),
  logo: z.string().max(450_000).nullable().optional(),
});

function serializeTeam(team) {
  return {
    id: team.id,
    name: team.name,
    sport: team.sport,
    country: team.country,
    city: team.city,
    logoPath: logoPath(team.id, team.logo_updated_at, team.logo_url),
    createdAt: team.created_at,
    updatedAt: team.updated_at,
  };
}

async function profileResponse(req) {
  const [team, counts] = await Promise.all([
    repository.getTeam(req.user.teamProfileId),
    logistics.statusCounts(req.user.teamProfileId),
  ]);
  if (!team) throw new HttpError(404, "Team not found");
  return {
    ...serializeTeam(team),
    admin: { name: req.user.name, email: req.user.email },
    requestCounts: counts,
  };
}

async function getProfile(req, res, next) {
  try {
    res.json({ data: await profileResponse(req) });
  } catch (error) {
    next(error);
  }
}

async function updateProfile(req, res, next) {
  try {
    const input = profileBody.parse(req.body);
    const patch = {
      name: input.name,
      sport: input.sport,
      country: input.country,
      city: input.city,
      adminName: input.adminName,
      adminAccountId: req.user.id,
    };
    patch.logo = await storeLogo(req.user.teamProfileId, input.logo);
    await repository.updateTeam(req.user.teamProfileId, patch);
    const fresh = await profileResponse({
      user: { ...req.user, name: input.adminName ?? req.user.name },
    });
    res.json({ data: fresh });
  } catch (error) {
    next(error);
  }
}

// Public: logos are not sensitive and are loaded by <img> tags.
async function getLogo(req, res, next) {
  try {
    const id = z.uuid().safeParse(req.params.id);
    const logo = id.success ? await repository.getLogo(id.data) : null;
    if (!logo) return res.status(404).json({ message: "No logo" });
    res.set({
      "Content-Type": logo.logo_mime,
      "Cache-Control": "public, max-age=86400",
      "Cross-Origin-Resource-Policy": "cross-origin",
    });
    res.send(logo.logo_data);
  } catch (error) {
    next(error);
  }
}

async function listRequests(req, res, next) {
  try {
    const { status, q, limit, offset } = req.query;
    const teamProfileId = req.user.teamProfileId;
    const [result, counts] = await Promise.all([
      logistics.listRequests({ teamProfileId, status, q, limit, offset }),
      logistics.statusCounts(teamProfileId),
    ]);
    res.json({
      data: result.rows.map((row) => serializeRequest(row, { audience: "team" })),
      total: result.total,
      counts,
    });
  } catch (error) {
    next(error);
  }
}

async function getRequest(req, res, next) {
  try {
    const row = await logistics.findByReference(req.params.reference, {
      teamProfileId: req.user.teamProfileId,
    });
    if (!row) throw new HttpError(404, "Request not found");
    res.json({ data: serializeRequest(row, { detail: true, audience: "team" }) });
  } catch (error) {
    next(error);
  }
}

async function createRequest(req, res, next) {
  try {
    const input = schemas.createRequest.parse(req.body);
    const reference = await logistics.createRequest({
      ...input,
      teamProfileId: req.user.teamProfileId,
      createdByTeamAdminId: req.user.teamAdminId,
      actor: actorOf(req),
    });
    // The saved draft has now become a real request.
    await repository.deleteDraft(req.user.teamAdminId);
    const row = await logistics.findByReference(reference);
    notify.requestCreated(row);
    res.status(201).json({
      data: serializeRequest(row, { detail: true, audience: "team" }),
    });
  } catch (error) {
    next(error);
  }
}

async function cancelRequest(req, res, next) {
  try {
    const reason = z
      .string()
      .trim()
      .max(1000)
      .optional()
      .parse(req.body?.reason);
    await logistics.changeStatus({
      reference: req.params.reference,
      teamProfileId: req.user.teamProfileId,
      to: "cancelled",
      reason,
      actor: actorOf(req),
      canMove: (from) => TEAM_CANCELLABLE.includes(from),
    });
    const row = await logistics.findByReference(req.params.reference, {
      teamProfileId: req.user.teamProfileId,
    });
    notify.requestStatusChanged(row, "cancelled", reason, { byTeam: true });
    res.json({ data: serializeRequest(row, { detail: true, audience: "team" }) });
  } catch (error) {
    next(error);
  }
}

async function getDraft(req, res, next) {
  try {
    const draft = await repository.getDraft(req.user.teamAdminId);
    res.json({
      data: draft ? draft.payload : null,
      updatedAt: draft ? draft.updated_at : null,
    });
  } catch (error) {
    next(error);
  }
}

async function saveDraft(req, res, next) {
  try {
    const payload = schemas.draft.parse(req.body);
    const saved = await repository.saveDraft(
      req.user.teamAdminId,
      req.user.teamProfileId,
      payload,
    );
    res.json({ updatedAt: saved.updated_at });
  } catch (error) {
    next(error);
  }
}

async function deleteDraft(req, res, next) {
  try {
    await repository.deleteDraft(req.user.teamAdminId);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  getProfile,
  updateProfile,
  getLogo,
  listRequests,
  getRequest,
  createRequest,
  cancelRequest,
  getDraft,
  saveDraft,
  deleteDraft,
  serializeTeam,
};
