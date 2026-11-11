const { HttpError } = require("./http-error");

const MAX_BYTES = 300 * 1024;

// Accepts a data URL ("data:image/png;base64,...") for PNG, JPEG or WebP only.
// SVG is rejected on purpose (scripts inside SVG files). The file's real magic
// bytes must match the declared type.
function parseLogoDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(",");
  const header = comma > 0 ? dataUrl.slice(0, comma) : "";
  const match = /^data:(image\/(?:png|jpeg|webp));base64$/.exec(header);
  if (!match) throw new HttpError(400, "Logo must be a PNG, JPEG or WebP image");
  const mime = match[1];
  const buffer = Buffer.from(dataUrl.slice(comma + 1), "base64");
  if (!buffer.length) throw new HttpError(400, "The logo file is empty");
  if (buffer.length > MAX_BYTES)
    throw new HttpError(400, "Logo is too large (300 KB maximum)");
  const isPng = buffer.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isJpeg = buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isWebp =
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP";
  const ok =
    (mime === "image/png" && isPng) ||
    (mime === "image/jpeg" && isJpeg) ||
    (mime === "image/webp" && isWebp);
  if (!ok) throw new HttpError(400, "The logo file is not a valid image");
  return { buffer, mime };
}

module.exports = { parseLogoDataUrl };
