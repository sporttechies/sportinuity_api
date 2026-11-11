// Sends email through Resend's HTTP API (no SDK needed).
// Env: RESEND_API_KEY, MAIL_FROM (e.g. "Sportinuity <no-reply@mail.sportinuity.com>")
//
// `attachments` is passed straight through, so invoices can later be sent as:
//   attachments: [{ filename: "invoice-SL-1050.pdf", content: <base64 string> }]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendMail({ to, subject, html, text, attachments, replyTo }) {
  const recipients = [...new Set([].concat(to || []).filter(Boolean))];
  if (!recipients.length) return { skipped: "no recipients" };
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[mail] RESEND_API_KEY not set - skipped "${subject}" to ${recipients.join(", ")}`);
    return { skipped: "no api key" };
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || "Sportinuity <no-reply@mail.sportinuity.com>",
      to: recipients,
      subject,
      html,
      text,
      reply_to: replyTo || process.env.MAIL_REPLY_TO || undefined,
      attachments,
    }),
  });
  if (!response.ok)
    throw new Error(`Resend ${response.status}: ${await response.text()}`);
  return response.json();
}

// Resend allows ~2 requests/second, so emails are sent one at a time with a
// short gap. Failures are logged and never break the request that triggered them.
let queue = Promise.resolve();
function sendMailSafe(options) {
  queue = queue
    .then(() => sendMail(options))
    .catch((error) => console.error(`[mail] "${options.subject}" failed:`, error.message))
    .then(() => sleep(550));
}

module.exports = { sendMail, sendMailSafe };
