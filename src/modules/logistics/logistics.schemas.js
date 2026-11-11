const { z } = require("zod");

const text = (max) => z.string().trim().max(max);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(value)), "Invalid date");
const optionalDate = z
  .union([date, z.literal("")])
  .nullish()
  .transform((value) => value || null);

const traveller = z.object({
  firstName: text(100).min(1, "First name is required"),
  lastName: text(100).min(1, "Last name is required"),
  type: z.enum(["regular", "vip", "vvip", "staff"]).default("regular"),
  documentNumber: text(60).nullish(),
  dietary: text(300).nullish(),
  category: z.enum(["adult", "child", "infant"]).default("adult"),
});
const travellers = z.array(traveller).min(1, "Add at least one traveller").max(300);

const contact = z.object({
  name: text(120).min(1, "Contact name is required"),
  email: text(254).email("Enter a valid contact email"),
  phone: text(40).min(3, "Contact phone is required"),
});

const trip = {
  event: text(200).min(2, "Event is required"),
  from: text(200).nullish(),
  location: text(200).min(2, "Destination is required"),
  departure: optionalDate,
  returnDate: optionalDate,
};

// Team (or manager) creating a request.
const createRequest = z.object({ ...trip, contact, travellers });

// Manager editing a request: every field optional.
const updateRequest = z.object({
  event: trip.event.optional(),
  from: text(200).nullish(),
  location: trip.location.optional(),
  departure: z.union([date, z.literal(""), z.null()]).optional(),
  returnDate: z.union([date, z.literal(""), z.null()]).optional(),
  managerNotes: text(4000).nullish(),
  contact: z
    .object({
      name: text(120).optional(),
      email: z.union([text(254).email(), z.literal("")]).optional(),
      phone: text(40).optional(),
    })
    .optional(),
  travellers: travellers.optional(),
});

// Saved "cart": deliberately lenient, it is a work in progress.
const draftText = (max) => z.string().max(max).default("");
const draft = z.object({
  trip: z.object({
    from: draftText(200),
    destination: draftText(200),
    departure: draftText(10),
    returnDate: draftText(10),
    adults: z.number().int().min(1).max(300).default(1),
    children: z.number().int().min(0).max(300).default(0),
    infants: z.number().int().min(0).max(300).default(0),
  }),
  event: draftText(200),
  contact: z
    .object({ name: draftText(120), email: draftText(254), phone: draftText(40) })
    .default({ name: "", email: "", phone: "" }),
  travellers: z
    .array(
      z.object({
        firstName: draftText(100),
        lastName: draftText(100),
        type: draftText(20).default("regular"),
        documentNumber: draftText(60),
        dietary: draftText(300),
        category: draftText(10).default("adult"),
      }),
    )
    .max(300)
    .default([]),
});

module.exports = { createRequest, updateRequest, draft, traveller, travellers };
