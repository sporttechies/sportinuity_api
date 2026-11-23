// Pure room-suggestion logic (no database), so it is easy to test.
const CAPACITY = { single: 1, double: 2, twin: 2, triple: 3, quad: 4 };
const capacityOf = (type, custom) => (type === "custom" ? custom || 2 : CAPACITY[type] || 2);

const chunk = (list, size) => {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * travellers: unassigned [{ id, category, type, index }]
 * proposals:  [{ roomType, travellerIds }] from the team
 * options:    { roomType, vipSingle }
 * returns:    [{ roomType, capacity, travellerIds }]
 */
function suggestRooms(travellers, proposals, { roomType = "twin", vipSingle = true } = {}) {
  const free = new Map(travellers.map((t) => [t.id, t]));
  const rooms = [];
  const take = (ids) => ids.filter((id) => free.has(id)).map((id) => {
    const t = free.get(id);
    free.delete(id);
    return t;
  });
  const base = capacityOf(roomType);

  // 1. What the team asked for comes first.
  for (const p of proposals) {
    const type = p.roomType || roomType;
    const capacity = capacityOf(type);
    const people = take(p.travellerIds);
    for (const group of chunk(people, capacity))
      rooms.push({ roomType: type, capacity, travellerIds: group.map((t) => t.id) });
  }

  // 2. VIP / VVIP guests get a single room each.
  if (vipSingle) {
    for (const t of [...free.values()].filter((x) => x.type === "vip" || x.type === "vvip")) {
      free.delete(t.id);
      rooms.push({ roomType: "single", capacity: 1, travellerIds: [t.id] });
    }
  }

  // 3. Everyone else: staff together, adults together, children/infants together.
  const rest = [...free.values()].sort((a, b) => a.index - b.index);
  const groups = [
    rest.filter((t) => t.category === "adult" && t.type === "staff"),
    rest.filter((t) => t.category === "adult" && t.type !== "staff"),
    rest.filter((t) => t.category !== "adult"),
  ];
  for (const group of groups)
    for (const part of chunk(group, base))
      rooms.push({
        roomType,
        capacity: base,
        travellerIds: part.map((t) => t.id),
      });
  return rooms;
}

module.exports = { suggestRooms, capacityOf, CAPACITY };
