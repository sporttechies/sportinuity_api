const SPORTS = [
  "Football",
  "Rugby",
  "Basketball",
  "Netball",
  "Volleyball",
  "Handball",
  "Hockey",
  "Cricket",
  "Athletics",
  "Swimming",
  "Tennis",
  "Boxing",
  "Cycling",
  "Golf",
  "Martial arts",
  "Multi-sport",
  "Other",
];

// Sports that register a squad (the roster step). Value = maximum players.
const TEAM_SPORT_LIMITS = {
  Football: 22,
  Rugby: 30,
  Basketball: 15,
  Netball: 12,
  Volleyball: 14,
  Handball: 16,
  Hockey: 18,
  Cricket: 15,
};

const AGE_CATEGORIES = [
  "Under 5",
  "Under 7",
  "Under 9 Boys",
  "Under 9 Girls",
  "Under 11 Boys",
  "Under 11 Girls",
  "Under 13 Boys",
  "Under 13 Girls",
  "Under 15 Boys",
  "Under 15 Girls",
  "Under 17 Boys",
  "Under 17 Girls",
  "Under 20 Boys",
  "Under 20 Girls",
  "Open Men",
  "Open Women",
];

const REQUEST_STATUSES = [
  "new",
  "in_review",
  "quoted",
  "confirmed",
  "completed",
  "cancelled",
  "rejected",
];

// Which statuses a manager may move a request to, from each status.
const MANAGER_TRANSITIONS = {
  new: ["in_review", "quoted", "confirmed", "rejected", "cancelled"],
  in_review: ["quoted", "confirmed", "rejected", "cancelled"],
  quoted: ["in_review", "confirmed", "rejected", "cancelled"],
  confirmed: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  rejected: ["in_review"],
};

// Statuses from which a team may cancel its own request.
const TEAM_CANCELLABLE = ["new", "in_review", "quoted"];

module.exports = {
  SPORTS,
  TEAM_SPORT_LIMITS,
  AGE_CATEGORIES,
  REQUEST_STATUSES,
  MANAGER_TRANSITIONS,
  TEAM_CANCELLABLE,
};
