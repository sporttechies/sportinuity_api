const { ZodError } = require("zod");

// Maps known errors to clean JSON responses. Anything unexpected is logged and
// returned as a generic 500 so internals never leak to the client.
function errorHandler(error, _req, res, _next) {
  if (error instanceof ZodError) {
    const first = error.issues[0];
    const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
    return res.status(400).json({
      message: first ? `${where}${first.message}` : "Invalid input",
      issues: error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  if (error.status && error.status >= 400 && error.status < 500)
    return res.status(error.status).json({ message: error.message });
  if (error.code === "23505")
    return res.status(409).json({ message: "That record already exists" });
  if (error.code === "23503")
    return res
      .status(409)
      .json({ message: "This record is linked to other data" });
  console.error("[api] unhandled error", error);
  res.status(500).json({ message: "Something went wrong" });
}

module.exports = { errorHandler };
