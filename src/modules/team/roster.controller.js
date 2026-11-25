// The saved squad of a team (team sports only). Every query is scoped to the
// logged-in team. Birth-certificate/passport documents are private: they are
// stored in the database and only served to the owning team and to managers.
const { z } = require("zod");
const repository = require("./roster.repository");
const teamRepository = require("./team.repository");
const { HttpError } = require("../../shared/http-error");
const { parseLogoDataUrl } = require("../../shared/logo-upload");
const { uploadPlayerPhoto, deletePlayerPhoto } = require("../../shared/cloudinary");
const { TEAM_SPORT_LIMITS } = require("../../shared/constants");
const notify = require("../../shared/mail/notify");

const PHOTO_MAX = 400 * 1024;
const DOCUMENT_MAX = 1500 * 1024;

const blank = (v) => (v === "" ? null : v);
const today = () => new Date().toISOString().slice(0, 10);

const playerBody = z.object({
  fullName: z.string().trim().min(2, "Enter the player's name").max(120),
  dateOfBirth: z.preprocess(
    blank,
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date of birth")
      .refine((d) => !Number.isNaN(Date.parse(d)) && d >= "1950-01-01" && d <= today(), "Enter a valid date of birth")
      .nullable()
      .optional(),
  ),
  jerseyNumber: z.preprocess(blank, z.string().trim().max(3).nullable().optional()),
  position: z.preprocess(blank, z.string().trim().max(40).nullable().optional()),
  photo: z.string().max(PHOTO_MAX * 1.4).optional(),
  document: z.string().max(DOCUMENT_MAX * 1.4).optional(),
});

function serializePlayer(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    dateOfBirth: row.date_of_birth,
    jerseyNumber: row.jersey_number,
    position: row.position,
    photoUrl: row.photo_url,
    hasDocument: row.has_document,
  };
}

async function teamSport(teamId) {
  const team = await teamRepository.getTeam(teamId);
  if (!team) throw new HttpError(404, "Team not found");
  const limit = TEAM_SPORT_LIMITS[team.sport];
  if (!limit) throw new HttpError(400, `${team.sport} teams don't register a squad`);
  return { team, limit };
}

async function getRoster(req, res, next) {
  try {
    const { team, limit } = await teamSport(req.user.teamProfileId);
    const players = await repository.listPlayers(team.id);
    res.json({
      data: {
        limit,
        players: players.map(serializePlayer),
        submittedAt: team.roster_submitted_at,
        status: team.roster_status,
        reviewNote: team.roster_review_note,
        reviewedAt: team.roster_reviewed_at,
      },
    });
  } catch (error) {
    next(error);
  }
}

function parsePhoto(dataUrl) {
  return parseLogoDataUrl(dataUrl, { maxBytes: PHOTO_MAX, label: "Player photo" });
}
function parseDocument(dataUrl) {
  return parseLogoDataUrl(dataUrl, { maxBytes: DOCUMENT_MAX, label: "Document" });
}

async function addPlayer(req, res, next) {
  try {
    const teamId = req.user.teamProfileId;
    const { limit } = await teamSport(teamId);
    const input = playerBody.parse(req.body);
    if (!input.photo) throw new HttpError(400, "Add the player's photo");
    if ((await repository.countPlayers(teamId)) >= limit)
      throw new HttpError(400, `A squad can have at most ${limit} players`);
    const photo = parsePhoto(input.photo);
    const document = input.document ? parseDocument(input.document) : null;
    const id = await repository.newPlayerId();
    const photoUrl = await uploadPlayerPhoto(teamId, id, photo);
    await repository.insertPlayer(teamId, id, {
      fullName: input.fullName,
      dateOfBirth: input.dateOfBirth ?? null,
      jerseyNumber: input.jerseyNumber ?? null,
      position: input.position ?? null,
      photoUrl,
      document,
    });
    await repository.markEdited(teamId);
    res.status(201).json({ data: serializePlayer(await repository.getPlayer(teamId, id)) });
  } catch (error) {
    next(error);
  }
}

async function updatePlayer(req, res, next) {
  try {
    const teamId = req.user.teamProfileId;
    const id = z.uuid().parse(req.params.id);
    await teamSport(teamId);
    const input = playerBody.partial().parse(req.body);
    if (!(await repository.getPlayer(teamId, id))) throw new HttpError(404, "Player not found");
    const patch = {
      fullName: input.fullName,
      dateOfBirth: input.dateOfBirth,
      jerseyNumber: input.jerseyNumber,
      position: input.position,
    };
    if (input.photo) patch.photoUrl = await uploadPlayerPhoto(teamId, id, parsePhoto(input.photo));
    if (input.document) patch.document = parseDocument(input.document);
    await repository.updatePlayer(teamId, id, patch);
    await repository.markEdited(teamId);
    res.json({ data: serializePlayer(await repository.getPlayer(teamId, id)) });
  } catch (error) {
    next(error);
  }
}

async function removePlayer(req, res, next) {
  try {
    const teamId = req.user.teamProfileId;
    const id = z.uuid().parse(req.params.id);
    if (!(await repository.deletePlayer(teamId, id))) throw new HttpError(404, "Player not found");
    await repository.markEdited(teamId);
    deletePlayerPhoto(teamId, id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

const submitBody = z.object({
  consent: z.literal(true, { error: "Please confirm the guardian consent statement" }),
});

async function submit(req, res, next) {
  try {
    const teamId = req.user.teamProfileId;
    const { team } = await teamSport(teamId);
    submitBody.parse(req.body);
    const missing = [];
    if (!team.age_category) missing.push("age category");
    if (!team.coach_name) missing.push("coach name");
    if (missing.length)
      throw new HttpError(400, `Complete your team details first: ${missing.join(", ")}`);
    if ((await repository.countPlayers(teamId)) < 1)
      throw new HttpError(400, "Add at least one player before submitting");
    if (team.roster_status === "submitted")
      throw new HttpError(409, "Your squad is already with us for review");
    await repository.submitRoster(teamId);
    const after = await teamRepository.getTeam(teamId);
    notify.rosterSubmitted({ team: after, players: await repository.countPlayers(teamId) });
    res.json({ data: { submittedAt: after.roster_submitted_at, status: after.roster_status } });
  } catch (error) {
    next(error);
  }
}

function sendDocument(res, doc) {
  res.set({
    "Content-Type": doc.document_mime,
    "Cache-Control": "private, no-store",
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
  });
  res.send(doc.document_data);
}

async function teamDocument(req, res, next) {
  try {
    const id = z.uuid().parse(req.params.id);
    const doc = await repository.getDocument(req.user.teamProfileId, id);
    if (!doc) throw new HttpError(404, "No document");
    sendDocument(res, doc);
  } catch (error) {
    next(error);
  }
}

// ---- manager side -------------------------------------------
async function managerRoster(req, res, next) {
  try {
    const teamId = z.uuid().parse(req.params.id);
    const team = await teamRepository.getTeam(teamId);
    if (!team) throw new HttpError(404, "Team not found");
    const players = await repository.listPlayers(teamId);
    res.json({
      data: {
        limit: TEAM_SPORT_LIMITS[team.sport] ?? null,
        players: players.map(serializePlayer),
        submittedAt: team.roster_submitted_at,
        status: team.roster_status,
        reviewNote: team.roster_review_note,
        reviewedAt: team.roster_reviewed_at,
      },
    });
  } catch (error) {
    next(error);
  }
}

async function managerDocument(req, res, next) {
  try {
    const teamId = z.uuid().parse(req.params.id);
    const playerId = z.uuid().parse(req.params.playerId);
    const doc = await repository.getDocument(teamId, playerId);
    if (!doc) throw new HttpError(404, "No document");
    sendDocument(res, doc);
  } catch (error) {
    next(error);
  }
}

const reviewBody = z
  .object({
    decision: z.enum(["approve", "request_changes"], { error: "Choose approve or request changes" }),
    note: z.preprocess(blank, z.string().trim().max(1000).nullable().optional()),
  })
  .refine((v) => v.decision === "approve" || (v.note && v.note.length >= 3), {
    message: "Tell the team what needs to change",
    path: ["note"],
  });

async function reviewRoster(req, res, next) {
  try {
    const teamId = z.uuid().parse(req.params.id);
    const team = await teamRepository.getTeam(teamId);
    if (!team) throw new HttpError(404, "Team not found");
    const input = reviewBody.parse(req.body);
    const ok = await repository.setReview(teamId, {
      status: input.decision === "approve" ? "approved" : "changes_requested",
      note: input.note ?? null,
      reviewerId: req.user.id,
    });
    if (!ok) throw new HttpError(409, "This squad isn't waiting for review");
    const after = await teamRepository.getTeam(teamId);
    notify.rosterReviewed({ team: after, approved: input.decision === "approve", note: input.note });
    res.json({
      data: { status: after.roster_status, reviewNote: after.roster_review_note, reviewedAt: after.roster_reviewed_at },
    });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  reviewRoster,
  getRoster, addPlayer, updatePlayer, removePlayer, submit, teamDocument,
  managerRoster, managerDocument,
};