// Money is calculated in whole cents so totals never drift by floating point.
const toCents = (value) => Math.round(Number(value) * 100);
const fromCents = (cents) => cents / 100;

/** items: [{ quantity, unitPrice }] -> line totals and invoice totals. */
function calculate(items, taxRate) {
  const lines = items.map((item) => toCents(item.quantity * item.unitPrice));
  const subtotal = lines.reduce((sum, cents) => sum + cents, 0);
  const tax = Math.round((subtotal * Number(taxRate)) / 100);
  return {
    lineTotals: lines.map(fromCents),
    subtotal: fromCents(subtotal),
    taxAmount: fromCents(tax),
    total: fromCents(subtotal + tax),
  };
}

function formatMoney(amount, currency) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${Number(amount).toFixed(2)}`;
  }
}

module.exports = { calculate, formatMoney, toCents };
