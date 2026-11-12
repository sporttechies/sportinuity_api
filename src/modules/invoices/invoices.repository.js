const { pool, query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");
const { calculate } = require("./invoices.money");

const SELECT = `
  SELECT i.id, i.invoice_number, i.logistics_request_id, i.team_profile_id, i.status,
         i.currency, i.tax_rate, i.subtotal, i.tax_amount, i.total, i.notes,
         i.issue_date::text AS issue_date, i.due_date::text AS due_date,
         i.issued_at, i.emailed_at, i.paid_at, i.voided_at, i.void_reason, i.snapshot,
         i.created_at, i.updated_at,
         lr.reference, lr.event_name, lr.origin, lr.destination,
         lr.departure_date::text AS departure_date, lr.return_date::text AS return_date,
         lr.traveller_count, lr.contact_name, lr.contact_email,
         tp.name AS team_name
    FROM invoices i
    JOIN logistics_requests lr ON lr.id = i.logistics_request_id
    JOIN team_profiles tp ON tp.id = i.team_profile_id`;

async function getSettings() {
  const { rows } = await query(
    `SELECT company_name, company_address, company_email, company_phone, tax_number,
            payment_instructions, invoice_footer, default_currency, default_tax_rate,
            payment_terms_days, bank_name, bank_account_name, bank_account_number,
            bank_swift_code FROM billing_settings WHERE id`,
  );
  return rows[0];
}

const SETTING_COLUMNS = {
  companyName: "company_name",
  companyAddress: "company_address",
  companyEmail: "company_email",
  companyPhone: "company_phone",
  taxNumber: "tax_number",
  paymentInstructions: "payment_instructions",
  invoiceFooter: "invoice_footer",
  defaultCurrency: "default_currency",
  defaultTaxRate: "default_tax_rate",
  paymentTermsDays: "payment_terms_days",
  bankName: "bank_name",
  bankAccountName: "bank_account_name",
  bankAccountNumber: "bank_account_number",
  bankSwiftCode: "bank_swift_code",
};

async function saveSettings(patch) {
  const sets = [];
  const values = [];
  for (const [key, column] of Object.entries(SETTING_COLUMNS)) {
    if (patch[key] === undefined) continue;
    values.push(patch[key]);
    sets.push(`${column} = $${values.length}`);
  }
  if (sets.length)
    await query(`UPDATE billing_settings SET ${sets.join(", ")}, updated_at = now() WHERE id`, values);
  return getSettings();
}

async function attachItems(rows) {
  if (!rows.length) return [];
  const { rows: items } = await query(
    `SELECT invoice_id, position, description, quantity, unit_price, line_total
       FROM invoice_items WHERE invoice_id = ANY($1::uuid[]) ORDER BY invoice_id, position`,
    [rows.map((row) => row.id)],
  );
  return rows.map((row) => ({
    ...row,
    items: items.filter((item) => item.invoice_id === row.id),
  }));
}

async function getInvoice(id, { teamProfileId } = {}) {
  const values = [id];
  let scope = "";
  if (teamProfileId) {
    values.push(teamProfileId);
    scope = " AND i.team_profile_id = $2";
  }
  const { rows } = await query(`${SELECT} WHERE i.id = $1${scope}`, values);
  return (await attachItems(rows))[0] || null;
}

async function listForRequest(requestId, { teamVisibleOnly = false } = {}) {
  const { rows } = await query(
    `${SELECT} WHERE i.logistics_request_id = $1 ${teamVisibleOnly ? "AND i.status <> 'draft'" : ""}
      ORDER BY i.created_at DESC`,
    [requestId],
  );
  return attachItems(rows);
}

async function listInvoices({ status, q, teamProfileId, limit = 25, offset = 0 }) {
  const values = [];
  const where = [];
  if (status) {
    values.push(String(status).split(",").filter(Boolean));
    where.push(`i.status = ANY($${values.length}::text[])`);
  }
  if (teamProfileId) {
    values.push(teamProfileId);
    where.push(`i.team_profile_id = $${values.length}`);
  }
  if (q) {
    values.push(`%${String(q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(
      `(i.invoice_number ILIKE $${values.length} OR lr.reference ILIKE $${values.length} OR tp.name ILIKE $${values.length})`,
    );
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await query(
    `SELECT count(*)::int AS n FROM invoices i
       JOIN logistics_requests lr ON lr.id = i.logistics_request_id
       JOIN team_profiles tp ON tp.id = i.team_profile_id ${clause}`,
    values,
  );
  const lim = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const off = Math.max(Number(offset) || 0, 0);
  const { rows } = await query(
    `${SELECT} ${clause} ORDER BY i.created_at DESC LIMIT ${lim} OFFSET ${off}`,
    values,
  );
  return { rows, total: total.rows[0].n, limit: lim, offset: off };
}

async function insertItems(client, invoiceId, items, totals) {
  for (let i = 0; i < items.length; i += 1) {
    await client.query(
      `INSERT INTO invoice_items (invoice_id, position, description, quantity, unit_price, line_total)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [invoiceId, i + 1, items[i].description, items[i].quantity, items[i].unitPrice, totals.lineTotals[i]],
    );
  }
}

async function createDraft({ request, actor, currency, taxRate, dueDate, notes, items }) {
  const totals = calculate(items, taxRate);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO invoices (logistics_request_id, team_profile_id, currency, tax_rate,
                             subtotal, tax_amount, total, notes, due_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [request.id, request.team_profile_id, currency, taxRate, totals.subtotal,
       totals.taxAmount, totals.total, notes || null, dueDate || null, actor.id],
    );
    await insertItems(client, rows[0].id, items, totals);
    await client.query("COMMIT");
    return rows[0].id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockDraft(client, id) {
  const { rows } = await client.query(`SELECT status FROM invoices WHERE id = $1 FOR UPDATE`, [id]);
  if (!rows[0]) throw new HttpError(404, "Invoice not found");
  if (rows[0].status !== "draft")
    throw new HttpError(409, "Only a draft invoice can be changed. Void it and create a new one instead.");
}

async function updateDraft(id, { currency, taxRate, dueDate, notes, items }, current) {
  const nextItems = items ?? current.items.map((item) => ({
    description: item.description,
    quantity: Number(item.quantity),
    unitPrice: Number(item.unit_price),
  }));
  const nextTax = taxRate ?? Number(current.tax_rate);
  const totals = calculate(nextItems, nextTax);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockDraft(client, id);
    await client.query(
      `UPDATE invoices SET currency = $2, tax_rate = $3, subtotal = $4, tax_amount = $5, total = $6,
              notes = $7, due_date = $8, updated_at = now() WHERE id = $1`,
      [id, currency ?? current.currency, nextTax, totals.subtotal, totals.taxAmount, totals.total,
       notes === undefined ? current.notes : notes || null,
       dueDate === undefined ? current.due_date : dueDate || null],
    );
    await client.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [id]);
    await insertItems(client, id, nextItems, totals);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function deleteDraft(id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockDraft(client, id);
    await client.query(`DELETE FROM invoices WHERE id = $1`, [id]); // items cascade
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Draft -> issued: takes the next number for the year and freezes the details. */
async function issue(id, { settings, actor }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT i.status, i.total, i.due_date, i.logistics_request_id, lr.reference,
              lr.contact_name, lr.contact_email, lr.event_name, tp.name AS team_name
         FROM invoices i
         JOIN logistics_requests lr ON lr.id = i.logistics_request_id
         JOIN team_profiles tp ON tp.id = i.team_profile_id
        WHERE i.id = $1 FOR UPDATE OF i`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, "Invoice not found");
    if (row.status === "void") throw new HttpError(409, "A voided invoice can't be issued");
    if (row.status === "issued" || row.status === "paid") {
      await client.query("COMMIT");
      return false; // already issued: nothing to do (used by "resend")
    }
    if (Number(row.total) <= 0) throw new HttpError(400, "An invoice needs a total above zero before it can be issued");

    const year = new Date().getUTCFullYear();
    const counter = await client.query(
      `INSERT INTO invoice_counters (year, last_number) VALUES ($1, 1)
       ON CONFLICT (year) DO UPDATE SET last_number = invoice_counters.last_number + 1
       RETURNING last_number`,
      [year],
    );
    const number = `INV-${year}-${String(counter.rows[0].last_number).padStart(4, "0")}`;
    const snapshot = {
      issuer: {
        companyName: settings.company_name,
        companyAddress: settings.company_address,
        companyEmail: settings.company_email,
        companyPhone: settings.company_phone,
        taxNumber: settings.tax_number,
        paymentInstructions: settings.payment_instructions,
        invoiceFooter: settings.invoice_footer,
        bankName: settings.bank_name,
        bankAccountName: settings.bank_account_name,
        bankAccountNumber: settings.bank_account_number,
        bankSwiftCode: settings.bank_swift_code,
      },
      billTo: {
        teamName: row.team_name,
        contactName: row.contact_name,
        contactEmail: row.contact_email,
      },
    };
    const updated = await client.query(
      `UPDATE invoices
          SET status = 'issued', invoice_number = $2, issue_date = CURRENT_DATE,
              due_date = COALESCE(due_date, CURRENT_DATE + $3::int),
              issued_at = now(), snapshot = $4, updated_at = now()
        WHERE id = $1 AND COALESCE(due_date, CURRENT_DATE + $3::int) >= CURRENT_DATE
        RETURNING id`,
      [id, number, settings.payment_terms_days, JSON.stringify(snapshot)],
    );
    if (!updated.rows.length)
      throw new HttpError(400, "The due date is in the past. Change it before issuing.");
    await client.query(
      `INSERT INTO request_events (logistics_request_id, actor_account_id, actor_role, action, note)
       VALUES ($1,$2,'manager','invoice_issued',$3)`,
      [row.logistics_request_id, actor.id, `Invoice ${number} issued`],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function markEmailed(id) {
  await query(`UPDATE invoices SET emailed_at = now() WHERE id = $1`, [id]);
}

async function voidInvoice(id, { reason, actor }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT status, invoice_number, logistics_request_id FROM invoices WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, "Invoice not found");
    if (row.status !== "issued")
      throw new HttpError(
        409,
        row.status === "void" ? "This invoice is already void"
          : row.status === "paid" ? "A paid invoice can't be voided. Mark it unpaid first."
          : "Delete a draft instead of voiding it",
      );
    await client.query(
      `UPDATE invoices SET status = 'void', voided_at = now(), void_reason = $2, updated_at = now() WHERE id = $1`,
      [id, reason],
    );
    await client.query(
      `INSERT INTO request_events (logistics_request_id, actor_account_id, actor_role, action, note)
       VALUES ($1,$2,'manager','invoice_voided',$3)`,
      [row.logistics_request_id, actor.id, `Invoice ${row.invoice_number} voided: ${reason}`],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Counts the request's travellers per class (regular / vip / vvip / staff). */
async function travellerClasses(requestId) {
  const { rows } = await query(
    `SELECT traveller_type AS type, count(*)::int AS count
       FROM request_travellers WHERE logistics_request_id = $1 GROUP BY traveller_type`,
    [requestId],
  );
  return rows;
}

/** issued <-> paid. Returns false when the invoice is already in that state. */
async function setPaid(id, { paid, actor }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT status, invoice_number, logistics_request_id FROM invoices WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, "Invoice not found");
    const from = paid ? "issued" : "paid";
    if (row.status === (paid ? "paid" : "issued")) {
      await client.query("COMMIT");
      return false;
    }
    if (row.status !== from)
      throw new HttpError(409, paid ? "Only an issued invoice can be marked paid" : "This invoice isn't marked paid");
    await client.query(
      `UPDATE invoices SET status = $2, paid_at = ${paid ? "now()" : "NULL"}, updated_at = now() WHERE id = $1`,
      [id, paid ? "paid" : "issued"],
    );
    await client.query(
      `INSERT INTO request_events (logistics_request_id, actor_account_id, actor_role, action, note)
       VALUES ($1,$2,'manager',$3,$4)`,
      [row.logistics_request_id, actor.id, paid ? "invoice_paid" : "invoice_unpaid",
       `Invoice ${row.invoice_number} marked ${paid ? "paid" : "unpaid"}`],
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  travellerClasses, setPaid,
  getSettings, saveSettings, getInvoice, listForRequest, listInvoices,
  createDraft, updateDraft, deleteDraft, issue, markEmailed, voidInvoice,
};
