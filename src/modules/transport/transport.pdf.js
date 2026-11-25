// Transport itinerary PDF.
const PDFDocument = require("pdfkit");
const { prepareLogo, loadLogo } = require("../invoices/invoices.pdf");

const INK = "#102331";
const MUTED = "#64748b";
const BLUE = "#007cc2";
const LINE = "#e2e8f0";
const MODES = { flight: "Flight", transfer: "Transfer", coach: "Coach", train: "Train", ferry: "Ferry", other: "Transport" };

const dateText = (v, opts) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ""));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-GB", { timeZone: "UTC", ...opts }) : "";
};
const LONG = { weekday: "short", day: "numeric", month: "short", year: "numeric" };

async function renderTransport(plan, { teamName, draft = false, companyName = "Sportinuity" } = {}) {
  await prepareLogo();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true, info: { Title: `Transport ${plan.reference}`, Author: companyName } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 50, right = 545, width = right - left, bottom = 770;
    let y = 50;
    const logo = loadLogo();
    let drew = false;
    if (logo) {
      try {
        const img = doc.openImage(logo);
        const s = Math.min(150 / img.width, 40 / img.height);
        doc.image(img, left, y, { width: img.width * s, height: img.height * s });
        y += img.height * s + 12;
        drew = true;
      } catch { /* fall back to the name */ }
    }
    if (!drew) {
      doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(20).text(companyName, left, y);
      y = doc.y + 8;
    }
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text("TRANSPORT ITINERARY", left, y);
    y = doc.y + 2;
    if (draft && plan.legs.some((l) => l.status !== "confirmed")) {
      doc.fillColor("#b45309").font("Helvetica-Bold").fontSize(10).text("Includes legs not yet confirmed", left, y);
      y = doc.y + 2;
    }
    y += 8;
    doc.fontSize(10);
    for (const [label, value] of [["Reference", plan.reference], ["Team", teamName], ["Event", plan.event], ["Route", [plan.origin, plan.destination].filter(Boolean).join(" to ")], ["Travellers", String(plan.travellerCount)]].filter(([, v]) => v)) {
      doc.fillColor(MUTED).font("Helvetica").text(`${label}:`, left, y, { width: 90 });
      doc.fillColor(INK).font("Helvetica-Bold").text(String(value), left + 95, y, { width: width - 95 });
      y = Math.max(doc.y, y + 14) + 2;
    }
    y += 12;

    if (!plan.legs.length) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(10).text("No transport planned yet.", left, y);
    }
    for (const l of plan.legs) {
      const rows = [
        l.carrier && ["Carrier", l.carrier],
        l.bookingReference && ["Booking ref", l.bookingReference],
        l.vehicle && ["Vehicle", l.vehicle],
        (l.driverName || l.driverPhone) && ["Driver", [l.driverName, l.driverPhone].filter(Boolean).join("  ")],
        l.meetingPoint && ["Meeting point", l.meetingPoint],
        ["Passengers", l.passengers ? l.passengers.join(", ") : `Everyone (${l.passengerCount})`],
        l.notes && ["Notes", l.notes],
      ].filter(Boolean);
      doc.font("Helvetica").fontSize(10);
      const rowsH = rows.reduce((h, [, v]) => h + Math.max(14, doc.heightOfString(String(v), { width: width - 130 })) + 2, 0);
      const h = 44 + rowsH + 10;
      if (y + h > bottom) { doc.addPage(); y = 50; }
      doc.roundedRect(left, y, width, h, 6).strokeColor(LINE).lineWidth(1).stroke();
      doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(9)
        .text(`${MODES[l.mode].toUpperCase()}${draft && l.status !== "confirmed" ? "  (not confirmed)" : ""}`, left + 12, y + 10);
      doc.fillColor(INK).fontSize(12).text(`${l.from}  >  ${l.to}`, left + 12, y + 22, { width: width - 24 });
      const when = [
        `${dateText(l.departDate, LONG)}${l.departTime ? " " + l.departTime : ""}`,
        l.arriveDate || l.arriveTime ? `arrives ${l.arriveDate ? dateText(l.arriveDate, { day: "numeric", month: "short" }) : ""}${l.arriveTime ? " " + l.arriveTime : ""}`.trim() : null,
      ].filter(Boolean).join("   ");
      doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(when, left + 12, y + 38, { width: width - 24 });
      let ry = y + 56;
      for (const [label, value] of rows) {
        doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(label, left + 12, ry, { width: 100 });
        doc.fillColor(INK).font("Helvetica").text(String(value), left + 120, ry, { width: width - 130 });
        ry += Math.max(14, doc.heightOfString(String(value), { width: width - 130 })) + 2;
      }
      y += h + 10;
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(`${companyName} · ${plan.reference} · Page ${i + 1} of ${range.count}`, left, 810, { width, align: "center", lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { renderTransport };
