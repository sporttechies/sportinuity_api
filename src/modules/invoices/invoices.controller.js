// Invoices. Managers create a draft from a request's travellers (one price per
// traveller class), issue it (number + PDF emailed to the team), mark it paid or
// void it. Teams can see and download issued invoices for their own requests.
const { z } = require("zod");
const repository = require("./invoices.repository");
const requests = require("../logistics/logistics.repository");
const { serializeInvoice, settingsJson } = require("./invoices.serializer");
const { renderInvoice } = require("./invoices.pdf");
const notify = require("../../shared/mail/notify");
const { HttpError } = require("../../shared/http-error");

const CLASSES = ["regular", "vip", "vvip", "staff"];
const CLASS_LABELS = { regular: "Regular", vip: "VIP", vvip: "VVIP", staff: "Staff" };
// Requests that can be invoiced: quoted, approved or finished.
const INVOICEABLE = ["quoted", "confirmed", "completed"];

const knownCurrencies = (() => {
  try {
    return new Set(Intl.supportedValuesOf("currency"));
  } catch {
    return null;
  }
})();
const currency = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{3}$/.test(value) && (!knownCurrencies || knownCurrencies.has(value)), "Unknown currency code");
const price = z.number().min(0).max(100_000_000);
const prices = z.object({
  regular: price.optional(),
  vip: price.optional(),
  vvip: price.optional(),
  staff: price.optional(),
});
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").nullable();
const text = (max) => z.string().trim().max(max);

const createBody = z.object({
  reference: z.string().trim().min(1),
  currency: currency.optional(),
  taxRate: z.number().min(0).max(100).optional(),
  dueDate: date.optional(),
  notes: text(2000).nullable().optional(),
  prices,
});
const updateBody = z.object({
  currency: currency.optional(),
  taxRate: z.number().min(0).max(100).optional(),
  dueDate: date.optional(),
  notes: text(2000).nullable().optional(),
  prices: prices.optional(),
});
const settingsBody = z.object({
  companyName: text(120).min(1),
  companyAddress: text(500).nullable().optional(),
  companyEmail: z.union([z.literal(""), z.email()]).nullable().optional(),
  companyPhone: text(60).nullable().optional(),
  taxNumber: text(60).nullable().optional(),
  paymentInstructions: text(1500).nullable().optional(),
  invoiceFooter: text(300).nullable().optional(),
  defaultCurrency: currency,
  defaultTaxRate: z.number().min(0).max(100),
  paymentTermsDays: z.number().int().min(0).max(365),
  bankName: text(120).nullable().optional(),
  bankAccountName: text(120).nullable().optional(),
  bankAccountNumber: text(60).nullable().optional(),
  bankSwiftCode: text(40).nullable().optional(),
}).partial();
const voidBody = z.object({ reason: text(500).min(3, "Give a reason") });
const idParam = z.uuid();

const actorOf = (req) => ({ id: req.user.id, role: "manager" });
const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (error) {
    next(error);
  }
};

const loadId = (req) => {
  const id = idParam.safeParse(req.params.id);
  if (!id.success) throw new HttpError(404, "Invoice not found");
  return id.data;
};
async function loadInvoice(req, scope) {
  const invoice = await repository.getInvoice(loadId(req), scope);
  if (!invoice) throw new HttpError(404, "Invoice not found");
  return invoice;
}
async function loadRequest(reference) {
  const request = await requests.findByReference(reference);
  if (!request) throw new HttpError(404, "Request not found");
  return request;
}

/** One line per traveller class that is actually on the request. */
async function buildItems(request, priceMap) {
  const counts = await repository.travellerClasses(request.id);
  if (!counts.length) throw new HttpError(400, "This request has no travellers to invoice");
  const items = [];
  for (const type of CLASSES) {
    const found = counts.find((c) => c.type === type);
    if (!found) continue;
    if (priceMap[type] === undefined)
      throw new HttpError(400, `Set a price for ${CLASS_LABELS[type]} travellers (${found.count} on this request)`);
    items.push({
      description: `${CLASS_LABELS[type]} traveller - ${request.event_name}`,
      quantity: found.count,
      unitPrice: priceMap[type],
    });
  }
  return items;
}

async function pdfFor(invoice) {
  const settings = invoice.status === "draft" ? await repository.getSettings() : null;
  return renderInvoice(invoice, settings);
}
function sendPdf(res, invoice, pdf) {
  const name = `${invoice.invoice_number || `draft-${invoice.reference}`}.pdf`;
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${name}"`,
    "Cache-Control": "private, no-store",
    "Content-Length": pdf.length,
  });
  res.send(pdf);
}

// ---- manager -----------------------------------------------------------------
const list = wrap(async (req, res) => {
  const { status, q, teamId, limit, offset } = req.query;
  const result = await repository.listInvoices({
    status, q, teamProfileId: z.uuid().safeParse(teamId).success ? teamId : undefined, limit, offset,
  });
  res.json({
    data: result.rows.map((row) => serializeInvoice({ ...row, items: [] })),
    total: result.total, limit: result.limit, offset: result.offset,
  });
});

const forRequest = wrap(async (req, res) => {
  const request = await loadRequest(req.params.reference);
  const [invoices, classes, settings] = await Promise.all([
    repository.listForRequest(request.id),
    repository.travellerClasses(request.id),
    repository.getSettings(),
  ]);
  const reason = !request.team_profile_id
    ? "This older request has no team, so it can't be invoiced."
    : !INVOICEABLE.includes(request.status)
      ? "Invoices can be created once a request is quoted or approved."
      : null;
  res.json({
    data: {
      invoices: invoices.map((row) => serializeInvoice(row)),
      classes: CLASSES.map((type) => ({ type, label: CLASS_LABELS[type], count: classes.find((c) => c.type === type)?.count ?? 0 }))
        .filter((c) => c.count > 0),
      defaults: {
        currency: String(settings.default_currency).trim(),
        taxRate: Number(settings.default_tax_rate),
        paymentTermsDays: settings.payment_terms_days,
      },
      canCreate: !reason,
      reason,
    },
  });
});

const create = wrap(async (req, res) => {
  const body = createBody.parse(req.body);
  const request = await loadRequest(body.reference);
  if (!request.team_profile_id) throw new HttpError(409, "This older request has no team, so it can't be invoiced.");
  if (!INVOICEABLE.includes(request.status))
    throw new HttpError(409, "Invoices can be created once a request is quoted or approved.");
  const settings = await repository.getSettings();
  const id = await repository.createDraft({
    request: { id: request.id, team_profile_id: request.team_profile_id },
    actor: actorOf(req),
    currency: body.currency ?? String(settings.default_currency).trim(),
    taxRate: body.taxRate ?? Number(settings.default_tax_rate),
    dueDate: body.dueDate,
    notes: body.notes,
    items: await buildItems(request, body.prices),
  });
  res.status(201).json({ data: serializeInvoice(await repository.getInvoice(id)) });
});

const get = wrap(async (req, res) => {
  res.json({ data: serializeInvoice(await loadInvoice(req)) });
});

const update = wrap(async (req, res) => {
  const body = updateBody.parse(req.body);
  const current = await loadInvoice(req);
  let items;
  if (body.prices) items = await buildItems(await loadRequest(current.reference), body.prices);
  await repository.updateDraft(current.id, { ...body, items }, current);
  res.json({ data: serializeInvoice(await repository.getInvoice(current.id)) });
});

const remove = wrap(async (req, res) => {
  await repository.deleteDraft(loadId(req));
  res.status(204).end();
});

const issue = wrap(async (req, res) => {
  const id = loadId(req);
  const settings = await repository.getSettings();
  const issuedNow = await repository.issue(id, { settings, actor: actorOf(req) });
  const invoice = await repository.getInvoice(id);
  // The send is awaited, so the manager learns right away if it didn't go out.
  let email = null;
  if (issuedNow) {
    email = await notify.invoiceIssued(invoice, await renderInvoice(invoice, null));
    if (email.status === "sent") await repository.markEmailed(id);
  }
  res.json({ data: serializeInvoice(await repository.getInvoice(id)), email });
});

const resend = wrap(async (req, res) => {
  const invoice = await loadInvoice(req);
  if (!["issued", "paid"].includes(invoice.status))
    throw new HttpError(409, "Only an issued invoice can be emailed");
  const email = await notify.invoiceIssued(invoice, await renderInvoice(invoice, null), { resent: true });
  if (email.status === "sent") await repository.markEmailed(invoice.id);
  res.json({ data: serializeInvoice(await repository.getInvoice(invoice.id)), email });
});

const markPaid = (paid) =>
  wrap(async (req, res) => {
    const id = loadId(req);
    await repository.setPaid(id, { paid, actor: actorOf(req) });
    res.json({ data: serializeInvoice(await repository.getInvoice(id)) });
  });

const voidIt = wrap(async (req, res) => {
  const { reason } = voidBody.parse(req.body);
  const id = loadId(req);
  await repository.voidInvoice(id, { reason, actor: actorOf(req) });
  res.json({ data: serializeInvoice(await repository.getInvoice(id)) });
});

const pdf = wrap(async (req, res) => {
  const invoice = await loadInvoice(req);
  sendPdf(res, invoice, await pdfFor(invoice));
});

const getSettings = wrap(async (_req, res) => {
  res.json({ data: settingsJson(await repository.getSettings()) });
});
const putSettings = wrap(async (req, res) => {
  const body = settingsBody.parse(req.body);
  for (const key of ["companyEmail", "companyAddress", "companyPhone", "taxNumber", "paymentInstructions", "invoiceFooter", "bankName", "bankAccountName", "bankAccountNumber", "bankSwiftCode"])
    if (body[key] === "") body[key] = null;
  res.json({ data: settingsJson(await repository.saveSettings(body)) });
});

// ---- team (own, issued invoices only) --------------------------------------------
const teamForRequest = wrap(async (req, res) => {
  const request = await requests.findByReference(req.params.reference, { teamProfileId: req.user.teamProfileId });
  if (!request) throw new HttpError(404, "Request not found");
  const invoices = await repository.listForRequest(request.id, { teamVisibleOnly: true });
  res.json({ data: invoices.map((row) => serializeInvoice(row, { audience: "team" })) });
});

const teamPdf = wrap(async (req, res) => {
  const invoice = await loadInvoice(req, { teamProfileId: req.user.teamProfileId });
  if (invoice.status === "draft") throw new HttpError(404, "Invoice not found");
  sendPdf(res, invoice, await renderInvoice(invoice, null));
});

module.exports = {
  list, forRequest, create, get, update, remove, issue, resend,
  paid: markPaid(true), unpaid: markPaid(false), void: voidIt, pdf,
  getSettings, putSettings, teamForRequest, teamPdf,
};
