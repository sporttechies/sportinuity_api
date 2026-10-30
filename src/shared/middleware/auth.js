const jwt = require("jsonwebtoken");
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token)
    return res.status(401).json({ message: "Authentication required" });
  try {
    req.user = jwt.verify(
      token,
      process.env.JWT_SECRET || "replace-this-secret-before-production",
    );
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
}
module.exports = { requireAuth };
