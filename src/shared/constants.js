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
  REQUEST_STATUSES,
  MANAGER_TRANSITIONS,
  TEAM_CANCELLABLE,
};
