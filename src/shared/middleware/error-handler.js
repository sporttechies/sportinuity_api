function errorHandler(error, _req, res, _next) {
  if (error.name === "ZodError")
    return res
      .status(400)
      .json({ message: "Invalid request", issues: error.issues });
  console.error(error);
  res.status(500).json({ message: "Internal server error" });
}
module.exports = { errorHandler };
