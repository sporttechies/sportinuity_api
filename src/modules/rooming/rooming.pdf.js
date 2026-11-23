// Hotel-ready rooming list as a PDF (pdfkit, built-in fonts).
const PDFDocument = require("pdfkit");
const { prepareLogo, loadLogo } = require("../invoices/invoices.pdf");

const INK = "#102331";
const MUTED = "#64748b";
const BLUE = "#007cc2";
const LINE = "#e2e8f0";

const TYPE_LABELS = { single: "Single", double: "Double", twin: "Twin", triple: "Triple", quad: "Quad", custom: "Custom" };
const CLASS_TAGS = { vip: "VIP", vvip: "VVIP", staff: "Staff" };

const dateText = (value) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  if (!m) return "";
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
};

const guestLine = (t) => {
  const tags = [CLASS_TAGS[t.type], t.category !== "adult" ? t.category : null].filter(Boolean);
  return `${t.firstName} ${t.lastName}`.trim() + (tags.length ? ` (${tags.join(", ")})` : "");
};

async function renderRoomingList(list, { teamName, companyName = "Sportinuity" } = {}) {
  await prepareLogo();
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      bufferPages: true,
      info: { Title: `Rooming list ${list.reference}`, Author: companyName },
    });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 50;
    const right = 545;
    const width = right - left;

    // Header
    const logo = loadLogo();
    let y = 50;
    if (logo) {
      try {
        const img = doc.openImage(logo);
        const scale = Math.min(150 / img.width, 40 / img.height);
        doc.image(img, left, y, { width: img.width * scale, height: img.height * scale });
        y += img.height * scale + 12;
      } catch {
        doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(20).text(companyName, left, y);
        y = doc.y + 8;
      }
    } else {
      doc.fillColor(BLUE).font("Helvetica-Bold").fontSize(20).text(companyName, left, y);
      y = doc.y + 8;
    }
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(20).text("ROOMING LIST", left, y);
    y = doc.y + 2;
    if (list.status !== "final") {
      doc.fillColor("#b45309").font("Helvetica-Bold").fontSize(10).text("DRAFT - not yet confirmed", left, y);
      y = doc.y + 2;
    }
    y += 8;

    const info = [
      ["Reference", list.reference],
      ["Team", teamName],
      ["Event", list.event],
      ["Hotel", list.hotel?.name],
      ["Destination", list.destination],
      ["Check-in", dateText(list.checkIn)],
      ["Check-out", dateText(list.checkOut)],
      ["Guests / rooms", `${list.rooms.reduce((n, r) => n + r.occupants.length, 0)} guests in ${list.rooms.length} rooms`],
    ].filter(([, v]) => v);
    doc.fontSize(10);
    for (const [label, value] of info) {
      doc.fillColor(MUTED).font("Helvetica").text(`${label}:`, left, y, { width: 90, continued: false });
      doc.fillColor(INK).font("Helvetica-Bold").text(String(value), left + 95, y, { width: width - 95 });
      y = Math.max(doc.y, y + 14) + 2;
    }
    if (list.notes) {
      y += 4;
      doc.fillColor(MUTED).font("Helvetica").text("Notes:", left, y, { width: 90 });
      doc.fillColor(INK).font("Helvetica").text(list.notes, left + 95, y, { width: width - 95 });
      y = doc.y + 4;
    }
    y += 10;

    // Table
    const col = { no: left, type: left + 130, guests: left + 215, notes: left + 400 };
    const headRow = (at) => {
      doc.rect(left, at, width, 22).fill("#f1f5f9");
      doc.fillColor(MUTED).font("Helvetica-Bold").fontSize(9);
      doc.text("ROOM", col.no + 8, at + 7, { width: 115 });
      doc.text("TYPE", col.type, at + 7, { width: 80 });
      doc.text("GUESTS", col.guests, at + 7, { width: 180 });
      doc.text("NOTES", col.notes, at + 7, { width: right - col.notes - 6 });
      return at + 22;
    };
    y = headRow(y);
    const bottom = 780;
    if (!list.rooms.length) {
      doc.fillColor(MUTED).font("Helvetica").fontSize(10).text("No rooms yet.", left + 8, y + 10);
      y += 30;
    }
    for (const room of list.rooms) {
      const guests = room.occupants.length ? room.occupants.map(guestLine).join("\n") : "Empty";
      doc.font("Helvetica").fontSize(10);
      const height = Math.max(
        24,
        doc.heightOfString(guests, { width: 180 }) + 12,
        room.notes ? doc.heightOfString(room.notes, { width: right - col.notes - 6 }) + 12 : 0,
      );
      if (y + height > bottom) {
        doc.addPage();
        y = headRow(50);
      }
      doc.fillColor(INK).font("Helvetica-Bold").text(room.label, col.no + 8, y + 7, { width: 115 });
      doc.fillColor(INK).font("Helvetica").text(`${TYPE_LABELS[room.roomType]} (${room.capacity})`, col.type, y + 7, { width: 80 });
      doc.fillColor(room.occupants.length ? INK : MUTED).text(guests, col.guests, y + 7, { width: 180 });
      if (room.notes) doc.fillColor(MUTED).text(room.notes, col.notes, y + 7, { width: right - col.notes - 6 });
      doc.moveTo(left, y + height).lineTo(right, y + height).strokeColor(LINE).lineWidth(0.5).stroke();
      y += height;
    }

    if (list.unassigned.length) {
      y += 16;
      if (y + 40 > bottom) { doc.addPage(); y = 50; }
      doc.fillColor("#b45309").font("Helvetica-Bold").fontSize(10).text(`Not yet placed (${list.unassigned.length})`, left, y);
      doc.fillColor(INK).font("Helvetica").text(list.unassigned.map(guestLine).join(", "), left, doc.y + 2, { width });
    }

    // Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(
        `${companyName} · ${list.reference} · Page ${i + 1} of ${range.count}`,
        left, 810, { width, align: "center", lineBreak: false },
      );
    }
    doc.end();
  });
}

module.exports = { renderRoomingList };
