const { parseLogoDataUrl } = require("./logo-upload");
const { uploadLogo, deleteLogo } = require("./cloudinary");

/**
 * Turns the `logo` field of a profile update into a repository patch:
 *   undefined -> leave unchanged,  null -> remove,  data URL -> upload.
 * The image is validated first, then stored on Cloudinary; only its URL is
 * kept in the database.
 */
async function storeLogo(teamId, logo) {
  if (logo === undefined) return undefined;
  if (logo === null) {
    await deleteLogo(teamId);
    return null;
  }
  if (!logo) return undefined;
  return { url: await uploadLogo(teamId, parseLogoDataUrl(logo)) };
}

module.exports = { storeLogo };
