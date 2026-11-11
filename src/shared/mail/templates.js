// HTML email templates. Every piece of user-supplied text goes through esc().
// Colours match the apps: blue #007cc2, green #17633e, lime #d0ee27, navy #102331.

const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const publicUrl = () =>
  (process.env.PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
const managerUrl = () =>
  (process.env.MANAGER_APP_URL || "http://localhost:3001").replace(/\/$/, "");

const STATUS_LABELS = {
  new: "New",
  in_review: "In review",
  quoted: "Quoted",
  confirmed: "Approved",
  completed: "Completed",
  cancelled: "Cancelled",
  rejected: "Not approved",
};

function layout({ preheader, heading, bodyHtml, cta }) {
  const base = publicUrl();
  const logo = base.startsWith("https://")
    ? `<img src="${base}/logo.png" alt="Sportinuity" height="40" style="display:block;height:40px;width:auto;border:0">`
    : `<span style="font-size:22px;font-weight:900;color:#007cc2">Sportinuity</span>`;
  const button = cta
    ? `<p style="margin:28px 0 0"><a href="${esc(cta.href)}" style="display:inline-block;background:#d0ee27;color:#25370d;font-weight:800;text-decoration:none;padding:14px 26px;border-radius:10px;font-size:15px">${esc(cta.label)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f4f7f8;font-family:Segoe UI,Arial,sans-serif;color:#102331">
<span style="display:none;max-height:0;overflow:hidden">${esc(preheader || "")}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f8;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden">
<tr><td style="padding:24px 32px;border-bottom:4px solid #007cc2">${logo}</td></tr>
<tr><td style="padding:32px">
<h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;color:#102331">${esc(heading)}</h1>
<div style="font-size:15px;line-height:1.65;color:#334155">${bodyHtml}</div>${button}
</td></tr>
<tr><td style="padding:20px 32px;background:#f8fafc;font-size:12px;color:#94a3b8">Sportinuity &middot; Sport travel, made simple</td></tr>
</table></td></tr></table></body></html>`;
}

function detailsTable(rows) {
  const lines = rows
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(
      ([label, value]) =>
        `<tr><td style="padding:8px 0;color:#64748b;width:38%;vertical-align:top">${esc(label)}</td><td style="padding:8px 0;font-weight:600;color:#102331">${esc(value)}</td></tr>`,
    )
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0">${lines}</table>`;
}

const tripRows = (request) => [
  ["Reference", request.reference],
  ["Team", request.team_name],
  ["Event", request.event_name],
  [
    "Route",
    request.origin ? `${request.origin} → ${request.destination}` : request.destination,
  ],
  [
    "Dates",
    request.departure_date
      ? `${request.departure_date}${request.return_date ? ` – ${request.return_date}` : ""}`
      : "",
  ],
  ["Travellers", request.traveller_count],
];

function teamWelcome({ adminName, teamName }) {
  return {
    subject: `Welcome to Sportinuity, ${teamName}`,
    html: layout({
      preheader: "Your team account is ready.",
      heading: `Welcome, ${adminName}`,
      bodyHtml: `<p>Your team account for <strong>${esc(teamName)}</strong> is ready. You can now plan travel, submit logistics requests for your team and follow their progress in one place.</p><p>Your travellers' details are saved as you go, so you can pick a request up where you left off.</p>`,
      cta: { label: "Go to your team desk", href: `${publicUrl()}/manage-request` },
    }),
    text: `Welcome, ${adminName}. Your team account for ${teamName} is ready: ${publicUrl()}/manage-request`,
  };
}

function managerNewTeam({ team, admin }) {
  return {
    subject: `New team registered: ${team.name}`,
    html: layout({
      preheader: `${team.name} just created an account.`,
      heading: "A new team has registered",
      bodyHtml: detailsTable([
        ["Team", team.name],
        ["Sport", team.sport],
        ["Country", team.country],
        ["City", team.city],
        ["Admin", admin.name],
        ["Email", admin.email],
      ]),
      cta: { label: "View teams", href: `${managerUrl()}/teams` },
    }),
    text: `New team registered: ${team.name} (${admin.name}, ${admin.email}). ${managerUrl()}/teams`,
  };
}

function requestReceived({ request }) {
  return {
    subject: `We received your request ${request.reference}`,
    html: layout({
      preheader: `Request ${request.reference} is with our team.`,
      heading: "Request received",
      bodyHtml: `<p>Thanks - your logistics request has been submitted and our team will review it shortly. We'll email you as soon as its status changes.</p>${detailsTable(tripRows(request))}`,
      cta: {
        label: "Track this request",
        href: `${publicUrl()}/manage-request/${encodeURIComponent(request.reference)}`,
      },
    }),
    text: `Request ${request.reference} received. Track it: ${publicUrl()}/manage-request/${request.reference}`,
  };
}

function managerNewRequest({ request }) {
  return {
    subject: `New request ${request.reference} - ${request.team_name}`,
    html: layout({
      preheader: `${request.team_name} submitted a request.`,
      heading: "New logistics request",
      bodyHtml: detailsTable([
        ...tripRows(request),
        ["Contact", request.contact_name],
        ["Contact email", request.contact_email],
        ["Contact phone", request.contact_phone],
      ]),
      cta: {
        label: "Review request",
        href: `${managerUrl()}/requests/${encodeURIComponent(request.reference)}`,
      },
    }),
    text: `New request ${request.reference} from ${request.team_name}. ${managerUrl()}/requests/${request.reference}`,
  };
}

function statusUpdate({ request, status, reason }) {
  const label = STATUS_LABELS[status] || status;
  const intro =
    {
      confirmed: "Good news - your request has been approved.",
      rejected: "Unfortunately we could not approve your request.",
      quoted: "We've prepared a quote for your request.",
      in_review: "Our team has started reviewing your request.",
      completed: "Your request has been marked as completed.",
      cancelled: "Your request has been cancelled.",
    }[status] || "The status of your request has changed.";
  const reasonHtml = reason
    ? `<p style="margin:12px 0;padding:12px 14px;background:#f8fafc;border-left:4px solid #007cc2;border-radius:6px"><strong>Note from our team:</strong><br>${esc(reason)}</p>`
    : "";
  return {
    subject: `Request ${request.reference}: ${label}`,
    html: layout({
      preheader: `${request.reference} is now ${label}.`,
      heading: `Request ${label.toLowerCase()}`,
      bodyHtml: `<p>${esc(intro)}</p>${reasonHtml}${detailsTable([...tripRows(request), ["Status", label]])}`,
      cta: {
        label: "View request",
        href: `${publicUrl()}/manage-request/${encodeURIComponent(request.reference)}`,
      },
    }),
    text: `Request ${request.reference} is now ${label}.${reason ? ` Note: ${reason}` : ""} ${publicUrl()}/manage-request/${request.reference}`,
  };
}

function managerCancelled({ request, reason }) {
  return {
    subject: `Request ${request.reference} cancelled by ${request.team_name}`,
    html: layout({
      preheader: `${request.team_name} cancelled ${request.reference}.`,
      heading: "A team cancelled a request",
      bodyHtml: `${reason ? `<p><strong>Reason:</strong> ${esc(reason)}</p>` : ""}${detailsTable(tripRows(request))}`,
      cta: {
        label: "View request",
        href: `${managerUrl()}/requests/${encodeURIComponent(request.reference)}`,
      },
    }),
    text: `${request.team_name} cancelled ${request.reference}. ${managerUrl()}/requests/${request.reference}`,
  };
}

module.exports = {
  esc,
  managerCancelled,
  teamWelcome,
  managerNewTeam,
  requestReceived,
  managerNewRequest,
  statusUpdate,
};
