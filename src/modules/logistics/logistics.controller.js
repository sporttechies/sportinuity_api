// Manager-facing request management: list, view, create, edit, approve,
// reject, change status and delete.
const { z } = require("zod");
const repository = require("./logistics.repository");
const schemas = require("./logistics.schemas");
const { serializeRequest } = require("./logistics.serializer");
const notify = require("../../shared/mail/notify");
const { HttpError } = require("../../shared/http-error");
const { REQUEST_STATUSES, MANAGER_TRANSITIONS } = require("../../shared/constants");

const actorOf = (req) => ({ id: req.user.id, role: "manager" });
const canMove = (from, to) => (MANAGER_TRANSITIONS[from] || []).includes(to);

const statusBody = z.object({
  status: z.enum(REQUEST_STATUSES),
  reason: z.string().trim().max(1000).optional(),
});
const rejectBody = z.object({
  reason: z.string().trim().min(3, "Give the team a reason").max(1000),
});
const createBody = schemas.createRequest.extend({ teamId: z.uuid() });

async function load(reference) {
  const row = await repository.findByReference(reference);
  if (!row) throw new HttpError(404, "Request not found");
  return row;
}

async function listRequests(req, res, next) {
  try {
    const { status, q, dateFrom, dateTo, limit, offset, teamId } = req.query;
    const [result, counts] = await Promise.all([
      repository.listRequests({
        status,
        q,
        dateFrom,
        dateTo,
        limit,
        offset,
        teamProfileId: teamId,
      }),
      repository.statusCounts(teamId),
    ]);
    res.json({
      data: result.rows.map((row) => serializeRequest(row)),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      counts,
    });
  } catch (error) {
    next(error);
  }
}

async function getRequest(req, res, next) {
  try {
    res.json({
      data: serializeRequest(await load(req.params.reference), { detail: true }),
    });
  } catch (error) {
    next(error);
  }
}

async function createRequest(req, res, next) {
  try {
    const { teamId, ...input } = createBody.parse(req.body);
    const reference = await repository.createRequest({
      ...input,
      teamProfileId: teamId,
      actor: actorOf(req),
    });
    const row = await load(reference);
    notify.requestCreated(row);
    res.status(201).json({ data: serializeRequest(row, { detail: true }) });
  } catch (error) {
    next(error);
  }
}

async function updateRequest(req, res, next) {
  try {
    const patch = schemas.updateRequest.parse(req.body);
    await load(req.params.reference);
    await repository.updateRequest(req.params.reference, patch, actorOf(req));
    res.json({
      data: serializeRequest(await load(req.params.reference), { detail: true }),
    });
  } catch (error) {
    next(error);
  }
}

async function move(req, res, to, reason) {
  await repository.changeStatus({
    reference: req.params.reference,
    to,
    reason,
    actor: actorOf(req),
    canMove,
  });
  const row = await load(req.params.reference);
  notify.requestStatusChanged(row, to, reason);
  res.json({ data: serializeRequest(row, { detail: true }) });
}

async function setStatus(req, res, next) {
  try {
    const { status, reason } = statusBody.parse(req.body);
    if (status === "rejected") rejectBody.parse({ reason });
    await move(req, res, status, reason);
  } catch (error) {
    next(error);
  }
}

async function approveRequest(req, res, next) {
  try {
    await move(req, res, "confirmed", z.string().trim().max(1000).optional().parse(req.body?.note));
  } catch (error) {
    next(error);
  }
}

async function rejectRequest(req, res, next) {
  try {
    const { reason } = rejectBody.parse(req.body);
    await move(req, res, "rejected", reason);
  } catch (error) {
    next(error);
  }
}

async function deleteRequest(req, res, next) {
  try {
    await repository.softDelete(req.params.reference, actorOf(req));
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

module.exports = {
  listRequests,
  getRequest,
  createRequest,
  updateRequest,
  setStatus,
  approveRequest,
  rejectRequest,
  deleteRequest,
};
