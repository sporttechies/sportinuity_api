// Supplier directory (manager only).
const { z } = require("zod");
const { query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");

const TYPES = ["accommodation", "transport", "catering", "other"];
const blank = (v) => (v === "" ? null : v);
const opt = (max) => z.preprocess(blank, z.string().trim().max(max).nullable().optional());

const body = z.object({
  name: z.string().trim().min(2).max(160),
  type: z.enum(TYPES, { error: "Choose a supplier type" }),
  contactName: opt(120),
  email: z.preprocess(blank, z.string().trim().email().max(254).nullable().optional()),
  phone: z.preprocess(
    blank,
    z.string().trim().regex(/^\+?[0-9 ()-]{6,24}$/, "Enter a valid phone number").nullable().optional(),
  ),
  city: opt(80),
  country: z.preprocess(blank, z.string().trim().length(2).toUpperCase().nullable().optional()),
  website: z.preprocess(blank, z.string().trim().url().max(300).nullable().optional()),
  notes: opt(1000),
  isActive: z.boolean().optional(),
});

const SELECT = `s.id, s.name, s.supplier_type, s.contact_name, s.email, s.phone, s.city,
  s.country, s.website, s.notes, s.is_active, s.created_at, s.updated_at,
  (SELECT count(*)::int FROM quotations q WHERE q.supplier_id = s.id) AS quotations,
  (SELECT count(*)::int FROM quotations q WHERE q.supplier_id = s.id AND q.status = 'accepted') AS accepted`;

const serialize = (r) => ({
  id: r.id,
  name: r.name,
  type: r.supplier_type,
  contactName: r.contact_name,
  email: r.email,
  phone: r.phone,
  city: r.city,
  country: r.country,
  website: r.website,
  notes: r.notes,
  isActive: r.is_active,
  quotations: r.quotations ?? 0,
  accepted: r.accepted ?? 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const dup = (error) =>
  error.code === "23505"
    ? new HttpError(409, "A supplier with this name and type already exists")
    : error;

async function list(req, res, next) {
  try {
    const type = req.query.type && TYPES.includes(String(req.query.type)) ? String(req.query.type) : null;
    const q = String(req.query.q || "").trim();
    const active = req.query.active === "true" ? true : req.query.active === "false" ? false : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const where = [];
    const values = [];
    if (type) { values.push(type); where.push(`s.supplier_type = $${values.length}`); }
    if (active !== null) { values.push(active); where.push(`s.is_active = $${values.length}`); }
    if (q) {
      values.push(`%${q.replace(/[%_\\]/g, "\\$&")}%`);
      where.push(`(s.name ILIKE $${values.length} OR s.city ILIKE $${values.length} OR s.contact_name ILIKE $${values.length})`);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows, total, counts] = await Promise.all([
      query(`SELECT ${SELECT} FROM suppliers s ${clause} ORDER BY s.is_active DESC, lower(s.name) LIMIT ${limit} OFFSET ${offset}`, values),
      query(`SELECT count(*)::int AS n FROM suppliers s ${clause}`, values),
      query(`SELECT supplier_type, count(*)::int AS n FROM suppliers GROUP BY 1`),
    ]);
    res.json({
      data: rows.rows.map(serialize),
      total: total.rows[0].n,
      counts: Object.fromEntries(counts.rows.map((r) => [r.supplier_type, r.n])),
    });
  } catch (error) {
    next(error);
  }
}

async function get(req, res, next) {
  try {
    const id = z.uuid().parse(req.params.id);
    const { rows } = await query(`SELECT ${SELECT} FROM suppliers s WHERE s.id = $1`, [id]);
    if (!rows.length) throw new HttpError(404, "Supplier not found");
    const recent = await query(
      `SELECT q.id, q.service_type, q.description, q.amount_cents, q.currency, q.status,
              q.created_at, lr.reference
         FROM quotations q JOIN logistics_requests lr ON lr.id = q.logistics_request_id
        WHERE q.supplier_id = $1 ORDER BY q.created_at DESC LIMIT 20`,
      [id],
    );
    res.json({
      data: {
        ...serialize(rows[0]),
        recentQuotations: recent.rows.map((r) => ({
          id: r.id,
          reference: r.reference,
          serviceType: r.service_type,
          description: r.description,
          amount: r.amount_cents == null ? null : r.amount_cents / 100,
          currency: r.currency,
          status: r.status,
          createdAt: r.created_at,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
}

async function create(req, res, next) {
  try {
    const i = body.parse(req.body);
    const { rows } = await query(
      `INSERT INTO suppliers (name, supplier_type, contact_name, email, phone, city, country, website, notes, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [i.name, i.type, i.contactName ?? null, i.email ?? null, i.phone ?? null, i.city ?? null,
       i.country ?? null, i.website ?? null, i.notes ?? null, i.isActive ?? true],
    );
    const out = await query(`SELECT ${SELECT} FROM suppliers s WHERE s.id = $1`, [rows[0].id]);
    res.status(201).json({ data: serialize(out.rows[0]) });
  } catch (error) {
    next(dup(error));
  }
}

async function update(req, res, next) {
  try {
    const id = z.uuid().parse(req.params.id);
    const i = body.partial().parse(req.body);
    const map = {
      name: "name", type: "supplier_type", contactName: "contact_name", email: "email", phone: "phone",
      city: "city", country: "country", website: "website", notes: "notes", isActive: "is_active",
    };
    const sets = [];
    const values = [id];
    for (const [key, column] of Object.entries(map)) {
      if (i[key] !== undefined) {
        values.push(i[key]);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (!sets.length) throw new HttpError(400, "Nothing to update");
    const result = await query(
      `UPDATE suppliers SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`,
      values,
    );
    if (!result.rowCount) throw new HttpError(404, "Supplier not found");
    const out = await query(`SELECT ${SELECT} FROM suppliers s WHERE s.id = $1`, [id]);
    res.json({ data: serialize(out.rows[0]) });
  } catch (error) {
    next(dup(error));
  }
}

// A supplier with quotations is kept for the records: deactivate it instead.
async function remove(req, res, next) {
  try {
    const id = z.uuid().parse(req.params.id);
    const used = await query(`SELECT 1 FROM quotations WHERE supplier_id = $1 LIMIT 1`, [id]);
    if (used.rows.length)
      throw new HttpError(409, "This supplier has quotations on file. Deactivate it instead of deleting.");
    const result = await query(`DELETE FROM suppliers WHERE id = $1`, [id]);
    if (!result.rowCount) throw new HttpError(404, "Supplier not found");
    res.status(204).end();
  } catch (error) {
    next(error);
  }
}

module.exports = { list, get, create, update, remove, TYPES };
