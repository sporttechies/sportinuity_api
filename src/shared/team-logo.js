// A team's logo: its Cloudinary URL, or (for logos uploaded before Cloudinary)
// a relative API path that the frontends prefix with their API base URL.
// `version` busts the browser cache when the logo changes.
function logoPath(teamId, logoUpdatedAt, logoUrl) {
  if (logoUrl) return logoUrl; // Cloudinary: a full https URL
  if (!teamId || !logoUpdatedAt) return null;
  return `/api/teams/${teamId}/logo?v=${new Date(logoUpdatedAt).getTime()}`;
}

module.exports = { logoPath };
