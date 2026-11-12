const n = (value) => (value === null || value === undefined ? null : Number(value));

function serializeInvoice(row, { audience = "manager" } = {}) {
  return {
    id: row.id,
    number: row.invoice_number,
    status: row.status,
    requestId: row.logistics_request_id,
    requestReference: row.reference,
    teamId: row.team_profile_id,
    team: row.team_name,
    event: row.event_name,
    currency: String(row.currency).trim(),
    taxRate: n(row.tax_rate),
    subtotal: n(row.subtotal),
    taxAmount: n(row.tax_amount),
    total: n(row.total),
    notes: row.notes,
    issueDate: row.issue_date,
    dueDate: row.due_date,
    issuedAt: row.issued_at,
    paidAt: row.paid_at,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    ...(audience === "manager" ? { emailedAt: row.emailed_at, createdAt: row.created_at } : {}),
    items: (row.items || []).map((item) => ({
      description: item.description,
      quantity: n(item.quantity),
      unitPrice: n(item.unit_price),
      lineTotal: n(item.line_total),
    })),
  };
}

const settingsJson = (s) => ({
  companyName: s.company_name,
  companyAddress: s.company_address,
  companyEmail: s.company_email,
  companyPhone: s.company_phone,
  taxNumber: s.tax_number,
  paymentInstructions: s.payment_instructions,
  invoiceFooter: s.invoice_footer,
  defaultCurrency: String(s.default_currency).trim(),
  defaultTaxRate: n(s.default_tax_rate),
  paymentTermsDays: s.payment_terms_days,
  bankName: s.bank_name,
  bankAccountName: s.bank_account_name,
  bankAccountNumber: s.bank_account_number,
  bankSwiftCode: s.bank_swift_code,
});

module.exports = { serializeInvoice, settingsJson };
