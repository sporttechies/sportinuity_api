const bcrypt = require("bcryptjs");
const { z } = require("zod");
const repository = require("./auth.repository");
const notify = require("../../shared/mail/notify");
const { signToken } = require("../../shared/middleware/auth");
const { HttpError } = require("../../shared/http-error");
const { SPORTS } = require("../../shared/constants");
const { logoPath } = require("../../shared/team-logo");

const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => value || null);

const registration = z.object({
  teamName: z.string().trim().min(2).max(120),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  password: z.string().min(8).max(128),
  sport: z.enum(SPORTS, { error: "Choose a sport" }),
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Choose a country"),
  city: optionalText(120),
});
const loginInput = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8).max(128),
});
const passwordInput = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(8).max(128),
});

const teamUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  teamName: user.team_name,
  teamProfileId: user.team_profile_id,
  logoPath: logoPath(user.team_profile_id, user.logo_updated_at, user.logo_url),
  role: "team_admin",
});
const managerUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: "manager",
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
      user: managerUser(user),
      token: signToken({ sub: user.id, email: user.email, role: "manager" }),
    });
  } catch (error) {
    next(error);
  }
}

const teamToken = (user) =>
  signToken({ sub: user.id, email: user.email, role: "team_admin" });

async function registerTeam(req, res, next) {
  try {
    const input = registration.parse(req.body);
    const email = input.email.toLowerCase();
    if (await repository.emailInUse(email))
      throw new HttpError(409, "An account already exists for this email");
    if (await repository.teamNameInUse(input.teamName))
      throw new HttpError(409, "A team with this name is already registered");
    let user;
    try {
      user = await repository.createTeamAdmin({
        ...input,
        email,
        passwordHash: await bcrypt.hash(input.password, 12),
      });
    } catch (error) {
      if (error.code === "23505")
        throw new HttpError(
          409,
          /team_profiles/.test(error.constraint || "")
            ? "A team with this name is already registered"
            : "An account already exists for this email",
        );
      throw error;
    }
    notify.teamRegistered({
      team: user.team,
      admin: { name: user.name, email: user.email },
    });
    res.status(201).json({ user: teamUser(user), token: teamToken(user) });
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
    res.json({ user: teamUser(user), token: teamToken(user) });
  } catch (error) {
    next(error);
  }
}

// req.user is loaded fresh from the database by the auth middleware.
async function me(req, res) {
  const u = req.user;
  if (u.role === "team_admin")
    return res.json({
      user: {
        id: u.id,
        email: u.email,
        name: u.name,
        teamName: u.teamName,
        teamProfileId: u.teamProfileId,
        logoPath: logoPath(u.teamProfileId, u.logoUpdatedAt, u.logoUrl),
        role: u.role,
      },
    });
  res.json({ user: { id: u.id, email: u.email, name: u.name, role: u.role } });
}

async function changePassword(req, res, next) {
  try {
    const input = passwordInput.parse(req.body);
    const hash = await repository.getPasswordHash(req.user.id);
    if (!hash || !(await bcrypt.compare(input.currentPassword, hash)))
      throw new HttpError(400, "Your current password is incorrect");
    await repository.setPasswordHash(
      req.user.id,
      await bcrypt.hash(input.newPassword, 12),
    );
    res.json({ message: "Password updated" });
  } catch (error) {
    next(error);
  }
}

module.exports = { registerTeam, loginTeam, loginManager, me, changePassword };
