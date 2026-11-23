// Catering sheet: meal schedule plus counted dietary requirements.
const PDFDocument = require("pdfkit");
const { prepareLogo, loadLogo } = require("../invoices/invoices.pdf");

const INK = "#102331";
const MUTED = "#64748b";
const BLUE = "#007cc2";
const LINE = "#e2e8f0";
const LABELS = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", snack: "Snack", packed: "Packed meal" };

const dateText = (v, opts) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ""));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-GB", { timeZone: "UTC", ...opts }) : "";
};

async function renderMealPlan(plan, { teamName, draft = false, companyName = "Sportinuity" } = {}) {
  await prepareLogo();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, bufferPages: true, info: { Title: `Meal plan ${plan.reference}`, Author: companyName } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 50, right = 545, width = right - left, bottom = 780;
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
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text("MEAL PLAN", left, y);
    y = doc.y + 2;
    const unconfirmed = plan.meals.some((m) => m.status !== "confirmed");
    if (draft && unconfirmed) {
      doc.fillColor("#b45309").font("Helvetica-Bold").fontSize(10).text("Includes meals not yet confirmed", left, y);
      y = doc.y + 2;
    }
    y += 8;
    const info = [
      ["Reference", plan.reference], ["Team", teamName], ["Event", plan.event], ["Destination", plan.destination],
      ["Dates", [dateText(plan.checkIn, { day: "numeric", month: "short", year: "numeric" }), dateText(plan.checkOut, { day: "numeric", month: "short", year: "numeric" })].filter(Boolean).join(" - ")],
      ["Guests", String(plan.travellerCount)],
    ].filter(([, v]) => v);
    doc.fontSize(10);
    for (const [label, value] of info) {
      doc.fillColor(MUTED).font("Helvetica").text(`${label}:`, left, y, { width: 90 });
      doc.fillColor(INK).font("Helvetica-Bold").text(String(value), left + 95, y, { width: width - 95 });
      y = Math.max(doc.y, y + 14) + 2;
    }
    y += 10;

    // Dietary summary
    const d = plan.dietary;
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text("Dietary requirements", left, y);
    y = doc.y + 6;
    doc.font("Helvetica").fontSize(10);
    if (!d.groups.length) {
      doc.fillColor(MUTED).text("No special requirements recorded.", left, y);
      y = doc.y + 4;
    } else {
      for (const g of d.groups) {
        const line = `${g.count} x ${g.label}`;
        const who = g.travellers.map((t) => t.name).join(", ");
        const h = doc.heightOfString(who, { width: width - 130 }) + 6;
        if (y + h > bottom) { doc.addPage(); y = 50; }
        doc.fillColor(INK).font("Helvetica-Bold").text(line, left, y, { width: 120 });
        doc.fillColor(MUTED).font("Helvetica").text(who, left + 130, y, { width: width - 130 });
        y = Math.max(doc.y, y + 14) + 4;
      }
      doc.fillColor(MUTED).font("Helvetica").text(`${d.none} guest${d.none === 1 ? "" : "s"} with no special requirements.`, left, y);
      y = doc.y + 4;
    }
    y += 12;

    // Schedule
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text("Schedule", left, y);
    y = doc.y + 6;
    const col = { when: left + 8, meal: left + 140, venue: left + 235, count: left + 400, menu: left + 435 };
    const head = (at) => {
      doc.rect(left, at, width, 22).fill("#f1f5f9");
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(9);
      doc.text("DATE / TIME", col.when, at + 7, { width: 125 });
      doc.text("MEAL", col.meal, at + 7, { width: 90 });
      doc.text("VENUE / MENU", col.venue, at + 7, { width: 160 });
      doc.text("GUESTS", col.count, at + 7, { width: 40 });
      return at + 22;
    };
    if (y + 60 > bottom) { doc.addPage(); y = 50; }
    y = head(y);
    if (!plan.meals.length) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(10).text("No meals scheduled yet.", left + 8, y + 10);
    }
    for (const m of plan.meals) {
      const detail = [m.venue, m.menu, m.notes].filter(Boolean).join("\n");
      doc.font("Helvetica").fontSize(10);
      const h = Math.max(26, doc.heightOfString(detail || " ", { width: 160 }) + 12);
      if (y + h > bottom) { doc.addPage(); y = head(50); }
      doc.fillColor(INK).font("Helvetica-Bold").text(dateText(m.date, { weekday: "short", day: "numeric", month: "short" }) + (m.time ? `  ${m.time}` : ""), col.when, y + 7, { width: 125 });
      doc.font("Helvetica").text(LABELS[m.type] + (m.status !== "confirmed" && draft ? " *" : ""), col.meal, y + 7, { width: 90 });
      doc.fillColor(INK).text(detail, col.venue, y + 7, { width: 160 });
      doc.text(String(m.headcount ?? plan.travellerCount), col.count, y + 7, { width: 40 });
      doc.moveTo(left, y + h).lineTo(right, y + h).strokeColor(LINE).lineWidth(0.5).stroke();
      y += h;
    }
    if (draft && unconfirmed) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text("* not yet confirmed", left, y + 6);
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(`${companyName} · ${plan.reference} · Page ${i + 1} of ${range.count}`, left, 810, { width, align: "center", lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { renderMealPlan };
