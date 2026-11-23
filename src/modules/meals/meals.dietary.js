// Turns the free-text dietary notes on travellers into counted groups for the caterer.
const NONE = new Set(["", "none", "no", "n/a", "na", "nil", "-", "no allergies", "none."]);

const tidy = (s) => s.trim().replace(/\s+/g, " ").replace(/[.]+$/, "");

/** "Vegetarian, no nuts" -> ["vegetarian", "no nuts"] */
function splitNeeds(text) {
  return String(text ?? "")
    .split(/[,;/\n]+|\s+and\s+/i)
    .map(tidy)
    .filter((s) => s && !NONE.has(s.toLowerCase()));
}

/**
 * travellers: [{id, firstName, lastName, dietary}]
 * -> { none: n, groups: [{label, count, travellers:[{id,name}]}] } sorted by count desc.
 * A person with several needs appears in each group.
 */
function summariseDietary(travellers) {
  const groups = new Map();
  let none = 0;
  for (const t of travellers) {
    const needs = splitNeeds(t.dietary);
    if (!needs.length) {
      none += 1;
      continue;
    }
    const seen = new Set();
    for (const need of needs) {
      const key = need.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!groups.has(key)) groups.set(key, { label: need, count: 0, travellers: [] });
      const g = groups.get(key);
      g.count += 1;
      g.travellers.push({ id: t.id, name: `${t.firstName} ${t.lastName}`.trim() });
    }
  }
  return {
    none,
    groups: [...groups.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}

module.exports = { splitNeeds, summariseDietary };
