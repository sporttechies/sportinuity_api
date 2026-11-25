// High-level notifications. Each function looks up recipients, builds the
// email and queues it. Nothing here ever throws into the calling request.
const { query } = require("../../config/db");
const { sendMailSafe, sendMailTracked } = require("./mailer");
const templates = require("./templates");

async function managerEmails() {
  const override = (process.env.MANAGER_NOTIFY_EMAIL || "")
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
  if (override.length) return override;
  const { rows } = await query(
    `SELECT email FROM auth_accounts WHERE account_type = 'manager' AND account_status = 'active'`,
  );
  return rows.map((row) => row.email);
}

async function teamAdminEmails(teamProfileId) {
  const { rows } = await query(
    `SELECT a.email FROM auth_accounts a
       JOIN team_admin_profiles tap ON tap.auth_account_id = a.id
      WHERE tap.team_profile_id = $1 AND a.account_status = 'active'`,
    [teamProfileId],
  );
  return rows.map((row) => row.email);
}

async function run(label, job) {
  try {
    await job();
  } catch (error) {
    console.error(`[notify] ${label} failed:`, error.message);
  }
}

function teamRegistered({ team, admin }) {
  return run("teamRegistered", async () => {
    const welcome = templates.teamWelcome({
      adminName: admin.name,
      teamName: team.name,
    });
    sendMailSafe({ to: admin.email, ...welcome });
    const notice = templates.managerNewTeam({ team, admin });
    sendMailSafe({ to: await managerEmails(), ...notice });
  });
}

function requestCreated(request) {
  return run("requestCreated", async () => {
    const team = await teamAdminEmails(request.team_profile_id);
    const received = templates.requestReceived({ request });
    sendMailSafe({ to: [...team, request.contact_email], ...received });
    sendMailSafe({
      to: await managerEmails(),
      ...templates.managerNewRequest({ request }),
    });
  });
}

// `byTeam` = the team itself made the change (e.g. cancelled), so managers are
// told too, instead of the team being emailed about its own action twice.
function requestStatusChanged(request, status, reason, { byTeam = false } = {}) {
  return run("requestStatusChanged", async () => {
    const team = await teamAdminEmails(request.team_profile_id);
    sendMailSafe({
      to: [...team, request.contact_email],
      ...templates.statusUpdate({ request, status, reason }),
    });
    if (byTeam)
      sendMailSafe({
        to: await managerEmails(),
        ...templates.managerCancelled({ request, reason }),
      });
  });
}

// pdf: Buffer of the invoice. Goes to the team's admins and the request contact.
// Resolves with { status: "sent" | "skipped" | "failed", reason?, recipients } so
// the manager can see whether the team really got it.
async function invoiceIssued(invoice, pdf, { resent = false } = {}) {
  try {
    const team = await teamAdminEmails(invoice.team_profile_id);
    const recipients = [...new Set([...team, invoice.contact_email].filter(Boolean))];
    if (!recipients.length)
      return { status: "skipped", reason: "No email address on file for this team", recipients };
    const result = await sendMailTracked({
      to: recipients,
      ...templates.invoiceIssued({ invoice, resent }),
      attachments: [
        { filename: `invoice-${invoice.invoice_number}.pdf`, content: pdf.toString("base64") },
      ],
    });
    return { ...result, recipients };
  } catch (error) {
    console.error("[notify] invoiceIssued failed:", error.message);
    return { status: "failed", reason: String(error.message).slice(0, 300), recipients: [] };
  }
}

// byTeam: team wrote it, so managers are emailed; otherwise the team's admins and request contact are.
function messagePosted(request, { body, byTeam, senderName }) {
  return run("messagePosted", async () => {
    const mail = templates.newMessage({ request, body, byTeam, senderName });
    const to = byTeam
      ? await managerEmails()
      : [...(await teamAdminEmails(request.team_profile_id)), request.contact_email];
    sendMailSafe({ to, ...mail });
  });
}

function staffAssigned(request, { to, name, role, note, by }) {
  return run("staffAssigned", async () => {
    sendMailSafe({ to, ...templates.staffAssigned({ request, name, role, note, by }) });
  });
}

function rosterSubmitted({ team, players }) {
  return run("rosterSubmitted", async () => {
    sendMailSafe({ to: await managerEmails(), ...templates.managerRosterSubmitted({ team, players }) });
  });
}

function rosterReviewed({ team, approved, note }) {
  return run("rosterReviewed", async () => {
    const admins = await teamAdminEmails(team.id);
    sendMailSafe({ to: [...admins, team.coach_email], ...templates.rosterReviewed({ team, approved, note }) });
  });
}

module.exports = {
  rosterSubmitted,
  rosterReviewed,
  staffAssigned,
  messagePosted,
  invoiceIssued,
  managerEmails,
  teamAdminEmails,
  teamRegistered,
  requestCreated,
  requestStatusChanged,
};
