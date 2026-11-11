const jwt = require("jsonwebtoken");
const { query } = require("../../config/db");

function jwtSecret() {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");
  return process.env.JWT_SECRET;
}

function signToken(claims, expiresIn = "8h") {
  return jwt.sign(claims, jwtSecret(), { expiresIn, algorithm: "HS256" });
}

// Verifies the bearer token, then re-loads the account so disabled accounts and
// role changes take effect immediately (not only when the token expires).
// With no roles given it accepts any authenticated, active account.
function requireRole(...roles) {
  return async (req, res, next) => {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token)
      return res.status(401).json({ message: "Authentication required" });
    let claims;
    try {
      claims = jwt.verify(token, jwtSecret(), { algorithms: ["HS256"] });
    } catch {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
    const { rows } = await query(
      `SELECT a.id, a.email, a.display_name AS name, a.account_type, a.account_status,
              tap.id AS team_admin_id, tap.team_profile_id,
              tp.name AS team_name, tp.logo_updated_at, tp.logo_url
         FROM auth_accounts a
         LEFT JOIN team_admin_profiles tap ON tap.auth_account_id = a.id
         LEFT JOIN team_profiles tp ON tp.id = tap.team_profile_id
        WHERE a.id = $1`,
      [claims.sub],
    );
    const account = rows[0];
    if (!account || account.account_status !== "active")
      return res.status(401).json({ message: "Session expired" });
    if (roles.length && !roles.includes(account.account_type))
      return res.status(403).json({ message: "You do not have access to this" });
    req.user = {
      id: account.id,
      email: account.email,
      name: account.name,
      role: account.account_type,
      teamAdminId: account.team_admin_id,
      teamProfileId: account.team_profile_id,
      teamName: account.team_name,
      logoUpdatedAt: account.logo_updated_at,
      logoUrl: account.logo_url,
    };
    next();
  };
}

const requireAuth = requireRole();

module.exports = { requireAuth, requireRole, signToken };
