// Minimal Cloudinary client (signed uploads over HTTPS, no SDK needed).
// Config: CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>
//    or:  CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
const crypto = require("crypto");
const { HttpError } = require("./http-error");

const FOLDER = "sportinuity/team-logos";

function config() {
  const url = process.env.CLOUDINARY_URL;
  if (url) {
    const match = /^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/.exec(url.trim());
    if (match) return { apiKey: match[1], apiSecret: match[2], cloud: match[3] };
  }
  const { CLOUDINARY_CLOUD_NAME: cloud, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: apiSecret } =
    process.env;
  return cloud && apiKey && apiSecret ? { cloud, apiKey, apiSecret } : null;
}

const publicId = (teamId) => `${FOLDER}/${teamId}`;

function sign(params, secret) {
  const text = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return crypto.createHash("sha1").update(text + secret).digest("hex");
}

async function call(cfg, action, params, extra = {}) {
  const signed = { ...params, timestamp: Math.floor(Date.now() / 1000) };
  const form = new FormData();
  Object.entries({ ...signed, ...extra }).forEach(([k, v]) => form.append(k, String(v)));
  form.append("api_key", cfg.apiKey);
  form.append("signature", sign(signed, cfg.apiSecret));
  let response;
  try {
    response = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloud}/image/${action}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    console.error("[cloudinary] request failed:", error.message);
    throw new HttpError(502, "Could not reach the image service. Try again.");
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("[cloudinary]", action, response.status, body?.error?.message);
    throw new HttpError(502, "The image service rejected the upload.");
  }
  return body;
}

/** Uploads (or replaces) a team's logo and returns its https URL. */
async function uploadLogo(teamId, { buffer, mime }) {
  const cfg = config();
  if (!cfg) throw new HttpError(503, "Image uploads aren't configured on the server");
  const result = await call(
    cfg,
    "upload",
    { public_id: publicId(teamId), overwrite: "true", invalidate: "true" },
    { file: `data:${mime};base64,${buffer.toString("base64")}` },
  );
  return result.secure_url;
}

/** Best effort: a leftover image is harmless, so failures are only logged. */
async function deleteLogo(teamId) {
  const cfg = config();
  if (!cfg) return;
  try {
    await call(cfg, "destroy", { public_id: publicId(teamId), invalidate: "true" });
  } catch (error) {
    console.error("[cloudinary] delete failed:", error.message);
  }
}

module.exports = { uploadLogo, deleteLogo, sign };
