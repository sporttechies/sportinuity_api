const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const repository = require("./auth.repository");
const registration = z.object({
  teamName: z.string().min(2).max(120),
  name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});
const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(128),
});
const secret = () => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");
  return process.env.JWT_SECRET;
};
const publicUser = (user, role = "team_admin") => ({
  id: user.id,
  email: user.email,
  name: user.name,
  teamName: user.team_name,
  teamProfileId: user.team_profile_id,
  role,
});
const managerTokenFor = (user) =>
  jwt.sign({ sub: user.id, email: user.email, role: "manager" }, secret(), {
    expiresIn: "8h",
  });
async function loginManager(req, res, next) {
  try {
    const input = loginInput.parse(req.body);
    const user = await repository.findManagerByEmail(input.email);
    if (
      !user ||
      user.account_status !== "active" ||
      !(await bcrypt.compare(input.password, user.password_hash))
    )
      return res.status(401).json({ message: "Invalid email or password" });
    res.json({
      user: publicUser(user, "manager"),
      token: managerTokenFor(user),
    });
  } catch (error) {
    next(error);
  }
}
const tokenFor = (user) =>
  jwt.sign(
    {
      sub: user.id,
      email: user.email,
      teamName: user.team_name,
      teamProfileId: user.team_profile_id,
      role: "team_admin",
    },
    secret(),
    { expiresIn: "8h" },
  );
async function registerTeam(req, res, next) {
  try {
    const input = registration.parse(req.body);
    const email = input.email.toLowerCase();
    const existing = await repository.findTeamAdminByEmail(email);
    if (existing)
      return res
        .status(409)
        .json({ message: "An account already exists for this email" });
    const user = await repository.createTeamAdmin({
      ...input,
      email,
      passwordHash: await bcrypt.hash(input.password, 12),
    });
    res.status(201).json({ user: publicUser(user), token: tokenFor(user) });
  } catch (error) {
    next(error);
  }
}
async function loginTeam(req, res, next) {
  try {
    const input = loginInput.parse(req.body);
    const user = await repository.findTeamAdminByEmail(input.email);
    if (
      !user ||
      user.account_status !== "active" ||
      !(await bcrypt.compare(input.password, user.password_hash))
    )
      return res.status(401).json({ message: "Invalid email or password" });
    res.json({ user: publicUser(user), token: tokenFor(user) });
  } catch (error) {
    next(error);
  }
}
async function me(req, res, next) {
  try {
    const account = await repository.findAccountById(req.user.sub);
    if (!account || account.account_status !== "active")
      return res.status(401).json({ message: "Session expired" });
    res.json({
      user: {
        id: account.id,
        email: account.email,
        name: account.name,
        role: account.account_type,
      },
    });
  } catch (error) {
    next(error);
  }
}
module.exports = { registerTeam, loginTeam, loginManager, me };
