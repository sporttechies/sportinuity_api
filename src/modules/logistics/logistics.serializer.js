const { logoPath } = require("../../shared/team-logo");

// audience "manager" sees everything; "team" never sees manager notes or the
// names of Sportinuity staff.
function serializeRequest(row, { detail = false, audience = "manager" } = {}) {
  const out = {
    id: row.reference,
    uuid: row.id,
    reference: row.reference,
    teamId: row.team_profile_id,
    team: row.team_name,
    teamSport: row.team_sport,
    teamCountry: row.team_country,
    teamLogoPath: logoPath(row.team_profile_id, row.team_logo_updated_at, row.team_logo_url),
    event: row.event_name,
    from: row.origin,
    location: row.destination,
    departure: row.departure_date,
    returnDate: row.return_date,
    people: row.traveller_count,
    status: row.status,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
    contact: {
      name: row.contact_name,
      email: row.contact_email,
      phone: row.contact_phone,
    },
  };
  if (audience === "manager") out.managerNotes = row.manager_notes;
  if (detail) {
    out.travellers = (row.travellers || []).map((t) => ({
      id: t.id,
      index: t.traveller_index,
      category: t.category,
      firstName: t.first_name,
      lastName: t.last_name,
      type: t.traveller_type,
      documentNumber: t.document_number,
      dietary: t.dietary_needs,
    }));
    out.events = (row.events || [])
      .filter((e) => audience === "manager" || e.action !== "edited" || e.actor_role !== "manager")
      .map((e) => ({
        id: e.id,
        action: e.action,
        fromStatus: e.from_status,
        toStatus: e.to_status,
        note: audience === "manager" || e.action === "status_changed" ? e.note : null,
        actorRole: e.actor_role,
        actorName:
          audience === "manager"
            ? e.actor_name
            : e.actor_role === "manager"
              ? "Sportinuity team"
              : e.actor_name,
        createdAt: e.created_at,
      }));
  }
  return out;
}

module.exports = { serializeRequest };
