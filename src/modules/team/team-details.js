// Fields shared by team registration and the team profile: edition, age
// category and coach. All optional here; the website asks for them on team sports.
const { z } = require("zod");
const { query } = require("../../config/db");
const { HttpError } = require("../../shared/http-error");
const { AGE_CATEGORIES } = require("../../shared/constants");

const blank = (value) => (value === "" ? null : value);

const teamDetails = {
  editionId: z.preprocess(blank, z.uuid().nullable().optional()),
  ageCategory: z.preprocess(
    blank,
    z.enum(AGE_CATEGORIES, { error: "Choose an age category" }).nullable().optional(),
  ),
  coachName: z.preprocess(blank, z.string().trim().min(2).max(120).nullable().optional()),
  coachEmail: z.preprocess(blank, z.string().trim().email().max(254).nullable().optional()),
  coachPhone: z.preprocess(
    blank,
    z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{6,24}$/, "Enter a valid phone number")
      .nullable()
      .optional(),
  ),
};

/** A team may only pick an edition that exists and is open for registration. */
async function ensureEditionOpen(editionId) {
  if (!editionId) return;
  const { rows } = await query(
    `SELECT is_open FROM tournament_editions WHERE id = $1`,
    [editionId],
  );
  if (!rows.length) throw new HttpError(400, "That edition does not exist");
  if (!rows[0].is_open) throw new HttpError(400, "Registration for that edition is closed");
}

module.exports = { teamDetails, ensureEditionOpen };
