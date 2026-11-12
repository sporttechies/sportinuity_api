// Renders an invoice to a PDF Buffer with pdfkit (built-in Helvetica, no fonts
// to ship). Issued invoices use the details frozen at issue time; drafts use
// the live settings and are stamped DRAFT.
const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

const INK = "#102331";
const MUTED = "#64748b";
const BLUE = "#007cc2";
const LINE = "#e2e8f0";

const money = (amount, currency) =>
  `${currency} ${new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(amount))}`;

const dateText = (value) => {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(value);
  return Number.isNaN(d.getTime())
    ? String(value)
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};

// The logo is read once. Put it at src/assets/logo.png (or .jpg), or point
// INVOICE_LOGO_PATH at it. Without one, the company name is printed instead.
let logoCache;
function loadLogo() {
  if (logoCache !== undefined) return logoCache;
  const dir = path.join(__dirname, "../../assets");
  const candidates = [process.env.INVOICE_LOGO_PATH, path.join(dir, "logo.png"), path.join(dir, "logo.jpg")].filter(Boolean);
  logoCache = null;
  for (const file of candidates) {
    try {
      logoCache = fs.readFileSync(file);
      break;
    } catch {
      /* try the next one */
    }
  }
  return logoCache;
}

const STAMPS = { draft: "DRAFT", void: "VOID", paid: "PAID" };

function renderInvoice(invoice, liveSettings) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      info: {
        Title: invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : `Draft invoice for ${invoice.reference}`,
        Author: "Sportinuity",
      },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const issuer = invoice.snapshot?.issuer || {
      companyName: liveSettings?.company_name,
      companyAddress: liveSettings?.company_address,
      companyEmail: liveSettings?.company_email,
      companyPhone: liveSettings?.company_phone,
      taxNumber: liveSettings?.tax_number,
      paymentInstructions: liveSettings?.payment_instructions,
      invoiceFooter: liveSettings?.invoice_footer,
    };
    const billTo = invoice.snapshot?.billTo || {
      teamName: invoice.team_name,
      contactName: invoice.contact_name,
      contactEmail: invoice.contact_email,
    };
    const currency = String(invoice.currency).trim();
    const left = 50;
    const right = 545;
    const width = right - left;

    // Status stamp behind the content.
    const stamp = STAMPS[invoice.status];
    if (stamp) {
      doc.save();
      doc.rotate(-30, { origin: [300, 420] });
      doc.fillColor(invoice.status === "paid" ? "#1c673e" : invoice.status === "void" ? "#b91c1c" : "#94a3b8")
        .opacity(0.12).font("Helvetica-Bold").fontSize(130)
        .text(stamp, 60, 360, { width: 480, align: "center", lineBreak: false });
      doc.restore();
    }

    // Header: logo (or the company name when there is no logo file)
    const logo = loadLogo();
    let headerBottom = 50;
    if (logo) {
      try {
        const img = doc.openImage(logo);
        const scale = Math.min(170 / img.width, 46 / img.height);
        doc.image(img, left, 46, { width: img.width * scale, height: img.height * scale });
        headerBottom = 46 + img.height * scale + 10;
      } catch {
        doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(22).text(issuer.companyName || "Sportinuity", left, 50);
        headerBottom = doc.y + 2;
      }
    } else {
      doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(22).text(issuer.companyName || "Sportinuity", left, 50);
      headerBottom = doc.y + 2;
    }
    doc.y = headerBottom;
    doc.fillColor(MUTED).font("Helvetica").fontSize(9);
    [issuer.companyAddress, issuer.companyEmail, issuer.companyPhone,
     issuer.taxNumber ? `Tax no. ${issuer.taxNumber}` : null]
      .filter(Boolean).forEach((line) => doc.text(line, left, doc.y, { width: 260 }));
    const addressBottom = doc.y;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(26).text("INVOICE", 345, 50, { width: 200, align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor(MUTED)
      .text(invoice.invoice_number || "Draft - not yet issued", 345, 82, { width: 200, align: "right" });

    // Bill to + meta
    const top = Math.max(addressBottom, 110) + 20;
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text("BILL TO", left, top);
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(billTo.teamName || "", left, top + 14, { width: 250 });
    doc.font("Helvetica").fontSize(10).fillColor(MUTED);
    if (billTo.contactName) doc.text(billTo.contactName, left, doc.y, { width: 250 });
    if (billTo.contactEmail) doc.text(billTo.contactEmail, left, doc.y, { width: 250 });
    const afterBillTo = doc.y;

    const meta = [
      ["Issue date", dateText(invoice.issue_date) || "-"],
      ["Due date", dateText(invoice.due_date) || "-"],
      ["Request", invoice.reference],
      ["Event", invoice.event_name],
      ["Route", invoice.origin ? `${invoice.origin} to ${invoice.destination}` : invoice.destination],
      ["Travel dates", invoice.departure_date
        ? `${dateText(invoice.departure_date)}${invoice.return_date ? ` - ${dateText(invoice.return_date)}` : ""}` : ""],
    ].filter(([, v]) => v);
    let metaY = top;
    meta.forEach(([label, value]) => {
      doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(label, 320, metaY, { width: 80 });
      doc.fillColor(INK).font("Helvetica-Bold").fontSize(9).text(String(value), 405, metaY, { width: 140, align: "right" });
      metaY = Math.max(doc.y, metaY + 14);
    });

    // Items table
    let y = Math.max(afterBillTo, metaY) + 28;
    doc.rect(left, y, width, 24).fill("#f1f5f9");
    doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8);
    doc.text("DESCRIPTION", left + 10, y + 8, { width: 250 });
    doc.text("QTY", 310, y + 8, { width: 40, align: "right" });
    doc.text("UNIT PRICE", 355, y + 8, { width: 85, align: "right" });
    doc.text("AMOUNT", 445, y + 8, { width: 90, align: "right" });
    y += 24;
    for (const item of invoice.items) {
      const rowHeight = Math.max(24, doc.font("Helvetica").fontSize(10).heightOfString(item.description, { width: 250 }) + 14);
      if (y + rowHeight > 700) { doc.addPage(); y = 50; }
      doc.fillColor(INK).font("Helvetica").fontSize(10).text(item.description, left + 10, y + 7, { width: 250 });
      doc.text(String(Number(item.quantity)), 310, y + 7, { width: 40, align: "right" });
      doc.text(money(item.unit_price, currency), 355, y + 7, { width: 85, align: "right" });
      doc.text(money(item.line_total, currency), 445, y + 7, { width: 90, align: "right" });
      y += rowHeight;
      doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();
    }

    // Totals
    y += 14;
    const totalRow = (label, value, bold) => {
      doc.fillColor(bold ? INK : MUTED).font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 12 : 10)
        .text(label, 330, y, { width: 100 });
      doc.fillColor(INK).text(value, 435, y, { width: 100, align: "right" });
      y += bold ? 22 : 18;
    };
    totalRow("Subtotal", money(invoice.subtotal, currency));
    if (Number(invoice.tax_rate) > 0) totalRow(`Tax (${Number(invoice.tax_rate)}%)`, money(invoice.tax_amount, currency));
    doc.moveTo(330, y).lineTo(right, y).strokeColor(INK).lineWidth(1).stroke();
    y += 8;
    totalRow(`Total due (${currency})`, money(invoice.total, currency), true);

    // Notes + payment details
    y += 14;
    const block = (title, text) => {
      if (!text) return;
      if (y > 700) { doc.addPage(); y = 50; }
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(8).text(title.toUpperCase(), left, y);
      doc.fillColor(INK).font("Helvetica").fontSize(10).text(text, left, doc.y + 3, { width });
      y = doc.y + 16;
    };
    block("Notes", invoice.notes);
    block("How to pay", issuer.paymentInstructions);
    if (invoice.status === "void" && invoice.void_reason) block("Void reason", invoice.void_reason);

    // Pay by bank transfer + QR code (not shown once paid or void).
    const hasBank = issuer.bankAccountNumber || issuer.bankName;
    if ((invoice.status === "draft" || invoice.status === "issued") && hasBank) {
      const boxHeight = 124;
      let payY = Math.max(y + 6, 610);
      if (payY + boxHeight > 765) {
        doc.addPage();
        payY = 50;
      }
      const paymentRef = invoice.invoice_number || invoice.reference;
      const rows = [
        ["Account name", issuer.bankAccountName],
        ["Bank", issuer.bankName],
        ["Account number", issuer.bankAccountNumber],
        ["SWIFT / BIC", issuer.bankSwiftCode],
        ["Amount", money(invoice.total, currency)],
        ["Reference", paymentRef],
      ].filter(([, v]) => v);

      doc.roundedRect(left, payY, width, boxHeight, 8).fill("#f8fafc");
      doc.roundedRect(left, payY, width, boxHeight, 8).strokeColor(LINE).lineWidth(1).stroke();
      doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(9).text("PAY BY BANK TRANSFER", left + 16, payY + 14);
      let rowY = payY + 32;
      rows.forEach(([label, value]) => {
        doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(label, left + 16, rowY, { width: 90 });
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(9).text(String(value), left + 110, rowY, { width: 230 });
        rowY += 14;
      });

      const payload = [
        issuer.bankAccountName && `Pay to: ${issuer.bankAccountName}`,
        issuer.bankName && `Bank: ${issuer.bankName}`,
        issuer.bankAccountNumber && `Account: ${issuer.bankAccountNumber}`,
        issuer.bankSwiftCode && `SWIFT/BIC: ${issuer.bankSwiftCode}`,
        `Amount: ${money(invoice.total, currency)}`,
        `Reference: ${paymentRef}`,
      ].filter(Boolean).join("\n");
      const qr = QRCode.create(payload, { errorCorrectionLevel: "M" });
      const quiet = 2;
      const cells = qr.modules.size;
      const qrSize = 84;
      const cell = qrSize / (cells + quiet * 2);
      const qrX = right - 16 - qrSize;
      const qrY = payY + 12;
      doc.rect(qrX, qrY, qrSize, qrSize).fill("#ffffff");
      doc.fillColor("#000000");
      for (let r = 0; r < cells; r += 1) {
        for (let c = 0; c < cells; c += 1) {
          if (qr.modules.get(r, c))
            doc.rect(qrX + (c + quiet) * cell, qrY + (r + quiet) * cell, cell + 0.2, cell + 0.2).fill();
        }
      }
      doc.fillColor(MUTED).font("Helvetica").fontSize(7.5)
        .text("Scan to see payment details", qrX - 8, qrY + qrSize + 5, { width: qrSize + 16, align: "center" });
    }

    if (issuer.invoiceFooter) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(8)
        .text(issuer.invoiceFooter, left, 780, { width, align: "center" });
    }
    doc.end();
  });
}

module.exports = { renderInvoice, money };
