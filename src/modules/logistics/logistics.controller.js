const { z } = require("zod");
const repository = require("./logistics.repository");
const travellerSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  type: z.enum(["regular", "vip", "vvip", "staff"]).default("regular"),
  documentNumber: z.string().optional(),
  dietary: z.string().optional(),
  category: z.enum(["adult", "child", "infant"]).optional(),
});
const requestSchema = z.object({
  team: z.string().min(2),
  event: z.string().min(2),
  location: z.string().min(2),
  people: z.number().int().positive(),
  from: z.string().optional(),
  departure: z.string().optional(),
  returnDate: z.string().optional(),
  contact: z
    .object({
      name: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
    })
    .optional(),
  travellers: z.array(travellerSchema).optional(),
});
function serialize(row) {
  return {
    id: row.reference,
    team: row.team_name,
    event: row.event_name,
    location: row.destination,
    people: row.traveller_count,
    status: row.status,
    createdAt: row.created_at,
    from: row.origin,
    departure: row.departure_date,
    returnDate: row.return_date,
    contact: {
      name: row.contact_name,
      email: row.contact_email,
      phone: row.contact_phone,
    },
    travellers: row.travellers || [],
  };
}
async function listRequests(_req, res, next) {
  try {
    res.json({ data: (await repository.listRequests()).map(serialize) });
  } catch (error) {
    next(error);
  }
}
async function createRequest(req, res, next) {
  try {
    const input = requestSchema.parse(req.body);
    const row = await repository.createRequest({
      ...input,
      destination: input.location,
      requestType: "team",
    });
    res.status(201).json({ data: serialize(row) });
  } catch (error) {
    next(error);
  }
}
async function createPublicRequest(req, res, next) {
  try {
    const input = requestSchema.parse({
      ...req.body,
      location: req.body.destination || req.body.location,
      people: Number(req.body.people || req.body.travellers),
    });
    const row = await repository.createRequest({
      ...input,
      destination: input.location,
      requestType: "public",
      reference: `SL-${Date.now().toString().slice(-8)}`,
    });
    res.status(201).json({ data: serialize(row) });
  } catch (error) {
    next(error);
  }
}
async function getPublicRequest(req, res, next) {
  try {
    const row = await repository.findByReference(req.params.id);
    if (!row) return res.status(404).json({ message: "Request not found" });
    res.json({ data: serialize(row) });
  } catch (error) {
    next(error);
  }
}
async function getManagedRequest(req, res, next) {
  return getPublicRequest(req, res, next);
}
module.exports = {
  listRequests,
  createRequest,
  createPublicRequest,
  getPublicRequest,
  getManagedRequest,
};
