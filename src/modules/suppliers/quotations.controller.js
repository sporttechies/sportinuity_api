// Supplier quotations recorded by managers against a team request. These are
// STL's internal costs: teams never see them (see the events filter in the
// logistics serializer) and they don't feed the team invoice.
const { z } = require("zod");
const { pool, query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");
const { TYPES } = require("./suppliers.controller");

const blank = (v) => (v === "" ? null : v);
const money = z.preprocess(
  (v) => (v === "" || v === undefined ? null : Number(v)),
  z.number().finite().min(0).max(1_000_000_000).nullable().optional(),
);

const base = z.object({
  supplierId: z.uuid(),
  serviceType: z.enum(TYPES).optional(),
  description: z.string().trim().min(2, "Describe what is being quoted").max(500),
  amount: money,
  currency: z.preprocess(blank, z.string().trim().length(3).toUpperCase().optional()),
  validUntil: z.preprocess(blank, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date").nullable().optional()),
  notes: z.preprocess(blank, z.string().trim().max(1000).nullable().optional()),
  status: z.enum(["requested", "received"]).optional(),
});
const createBody = base.extend({ reference: z.string().trim().min(3).max(40) });
const updateBody = base.omit({ supplierId: true }).partial();

const SELECT = `
  SELECT q.id, q.logistics_request_id, q.supplier_id, q.service_type, q.description,
         q.amount_cents, q.currency, q.valid_until::text AS valid_until, q.status, q.notes,
         q.decided_at, q.created_at, q.updated_at,
         s.name AS supplier_name, s.supplier_type, s.contact_name, s.email AS supplier_email,
         s.phone AS supplier_phone, s.is_active AS supplier_active, lr.reference
    FROM quotations q
    JOIN suppliers s ON s.id = q.supplier_id
    JOIN logistics_requests lr ON lr.id = q.logistics_request_id`;

const today = () => new Date().toISOString().slice(0, 10);

function serialize(r) {
  return {
    id: r.id,
    reference: r.reference,
    supplier: {
      id: r.supplier_id,
      name: r.supplier_name,
      type: r.supplier_type,
      contactName: r.contact_name,
      email: r.supplier_email,
      phone: r.supplier_phone,
      isActive: r.supplier_active,
    },
    serviceType: r.service_type,
    description: r.description,
    amount: r.amount_cents == null ? null : Number(r.amount_cents) / 100,
    currency: r.currency,
    validUntil: r.valid_until,
    expired: r.status === "received" && !!r.valid_until && r.valid_until < today(),
    status: r.status,
    notes: r.notes,
    decidedAt: r.decided_at,
    createdAt: r.created_at,
  };
}

async function requestByReference(reference) {
  const { rows } = await query(
    `SELECT id, reference, status FROM logistics_requests
      WHERE reference = $1 AND deleted_at IS NULL`,
    [String(reference).toUpperCase()],
  );
  if (!rows.length) throw new HttpError(404, "Request not found");
  return rows[0];
}

async function loadOne(id, client = { query }) {
  const { rows } = await client.query(`${SELECT} WHERE q.id = $1`, [id]);
  return rows[0];
}

async function addEvent(client, row, actor, action, note) {
  await client.query(
    `INSERT INTO request_events (logistics_request_id, actor_account_id, actor_role, action, note)
     VALUES ($1,$2,'manager',$3,$4)`,
    [row.logistics_request_id, actor.id, action, note],
  );
}

const label = (row) =>
  `${row.supplier_name} (${row.service_type})${row.amount_cents == null ? "" : `, ${row.currency} ${(Number(row.amount_cents) / 100).toFixed(2)}`}`;

async function forRequest(req, res, next) {
  try {
    const request = await requestByReference(req.params.reference);
    const { rows } = await query(`${SELECT} WHERE q.logistics_request_id = $1 ORDER BY q.created_at`, [request.id]);
    const data = rows.map(serialize);
    res.json({
      data,
      assigned: data.filter((q) => q.status === "accepted"),
    });
  } catch (error) {
    next(error);
  }
}

async function create(req, res, next) {
  try {
    const i = createBody.parse(req.body);
    const request = await requestByReference(i.reference);
    if (["cancelled", "rejected"].includes(request.status))
      throw new HttpError(400, `This request is ${request.status}; quotations can't be added`);
    const supplier = await query(`SELECT id, supplier_type, is_active FROM suppliers WHERE id = $1`, [i.supplierId]);
    if (!supplier.rows.length) throw new HttpError(400, "That supplier does not exist");
    if (!supplier.rows[0].is_active) throw new HttpError(400, "That supplier is inactive");
    const status = i.status ?? (i.amount == null ? "requested" : "received");
    if (status === "received" && i.amount == null) throw new HttpError(400, "Enter the quoted amount");
    const { rows } = await query(
      `INSERT INTO quotations
         (logistics_request_id, supplier_id, service_type, description, amount_cents, currency,
          valid_until, status, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [request.id, i.supplierId, i.serviceType ?? supplier.rows[0].supplier_type, i.description,
       i.amount == null ? null : Math.round(i.amount * 100), i.currency ?? "USD",
       i.validUntil ?? null, status, i.notes ?? null, req.user.id],
    );
    const row = await loadOne(rows[0].id);
    await addEvent({ query }, row, req.user, "quote_added",
      `${status === "requested" ? "Quote requested from" : "Quote received from"} ${label(row)}`);
    res.status(201).json({ data: serialize(row) });
  } catch (error) {
    next(error);
  }
}

async function update(req, res, next) {
  try {
    const id = z.uuid().parse(req.params.id);
    const i = updateBody.parse(req.body);
    const current = await loadOne(id);
    if (!current) throw new HttpError(404, "Quotation not found");
    if (!["requested", "received"].includes(current.status))
      throw new HttpError(409, `A ${current.status} quotation can't be edited. Reopen it first.`);
    const amountCents =
      i.amount === undefined ? current.amount_cents : i.amount === null ? null : Math.round(i.amount * 100);
    let status = i.status ?? current.status;
    if (amountCents != null && status === "requested" && i.status === undefined) status = "received";
    if (status === "received" && amountCents == null) throw new HttpError(400, "Enter the quoted amount");
    await query(
      `UPDATE quotations SET service_type = $2, description = $3, amount_cents = $4, currency = $5,
              valid_until = $6, status = $7, notes = $8, updated_at = now()
        WHERE id = $1`,
      [id, i.serviceType ?? current.service_type, i.description ?? current.description, amountCents,
       i.currency ?? current.currency,
       i.validUntil === undefined ? current.valid_until : i.validUntil,
       status, i.notes === undefined ? current.notes : i.notes],
    );
    const row = await loadOne(id);
    if (current.status === "requested" && status === "received")
      await addEvent({ query }, row, req.user, "quote_added", `Quote received from ${label(row)}`);
    res.json({ data: serialize(row) });
  } catch (error) {
    next(error);
  }
}

/** Runs a decision (accept/reject/reopen) in a transaction. */
async function decide(req, res, next, apply) {
  const client = await pool.connect();
  try {
    const id = z.uuid().parse(req.params.id);
    await client.query("BEGIN");
    const { rows } = await client.query(`${SELECT} WHERE q.id = $1 FOR UPDATE OF q`, [id]);
    const row = rows[0];
    if (!row) throw new HttpError(404, "Quotation not found");
    await apply(client, row);
    await client.query("COMMIT");
    res.json({ data: serialize(await loadOne(id)) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
}

const accept = (req, res, next) =>
  decide(req, res, next, async (client, row) => {
    if (row.status !== "received")
      throw new HttpError(409, row.status === "accepted" ? "Already accepted" : "Only a received quotation can be accepted");
    if (!row.supplier_active) throw new HttpError(400, "That supplier is inactive");
    if (row.service_type !== "other") {
      // Replace whoever was previously chosen for this service on the request.
      const replaced = await client.query(
        `UPDATE quotations SET status = 'rejected', decided_at = now(), updated_at = now()
          WHERE logistics_request_id = $1 AND service_type = $2 AND status = 'accepted' AND id <> $3
          RETURNING id`,
        [row.logistics_request_id, row.service_type, row.id],
      );
      if (replaced.rows.length)
        await addEvent(client, row, req.user, "quote_rejected", `Replaced as the ${row.service_type} supplier`);
    }
    await client.query(
      `UPDATE quotations SET status = 'accepted', decided_at = now(), updated_at = now() WHERE id = $1`,
      [row.id],
    );
    await addEvent(client, row, req.user, "quote_accepted", `Accepted ${label(row)}`);
  });

const reject = (req, res, next) =>
  decide(req, res, next, async (client, row) => {
    if (row.status === "rejected") throw new HttpError(409, "Already rejected");
    await client.query(
      `UPDATE quotations SET status = 'rejected', decided_at = now(), updated_at = now() WHERE id = $1`,
      [row.id],
    );
    await addEvent(client, row, req.user, "quote_rejected", `Rejected ${label(row)}`);
  });

const reopen = (req, res, next) =>
  decide(req, res, next, async (client, row) => {
    if (!["accepted", "rejected"].includes(row.status)) throw new HttpError(409, "Nothing to reopen");
    await client.query(
      `UPDATE quotations SET status = $2, decided_at = NULL, updated_at = now() WHERE id = $1`,
      [row.id, row.amount_cents == null ? "requested" : "received"],
    );
    await addEvent(client, row, req.user, "quote_added", `Reopened ${label(row)}`);
  });

async function remove(req, res, next) {
  try {
    const id = z.uuid().parse(req.params.id);
    const row = await loadOne(id);
    if (!row) throw new HttpError(404, "Quotation not found");
    if (row.status === "accepted") throw new HttpError(409, "Reject or reopen an accepted quotation before deleting it");
    await query(`DELETE FROM quotations WHERE id = $1`, [id]);
    await addEvent({ query }, row, req.user, "quote_removed", `Removed ${label(row)}`);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

module.exports = { forRequest, create, update, accept, reject, reopen, remove };
