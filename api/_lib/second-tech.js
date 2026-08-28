// Juan (Houston) and Zach (Austin) are single-tech metros: each brings their
// OWN off-schedule helper (a spouse/second person who never appears in the
// CRM) on a two-person job, rather than the office assigning a second real
// technician. The customer is still charged the two-person fee — it rides on
// the line items — but no roster secondary tech is ever assigned, or required,
// when one of these two is the primary. Denver has real techs on the roster,
// so a large-TV job there DOES get a genuine second technician auto-assigned.
//
// Matched case-insensitively by first name. This is the single source of
// truth for that list — api/admin.js (the staff booking form) and api/book.js
// (the public widget) both import it, so a name added here covers both paths
// without risking the two definitions drifting apart. The frontend
// (nbPopulateSecondTechs() in admin.html) also hides these names from the
// second-tech dropdown for the same reason; keep it in sync by hand since it
// runs in the browser and can't import this file.
export const SECONDARY_INELIGIBLE_NAMES = ['juan', 'zach'];

export function isSecondaryIneligibleName(name) {
  return SECONDARY_INELIGIBLE_NAMES.includes((name || '').trim().toLowerCase());
}

// Readable alias for the primary-side rule: does THIS tech, as primary, bring
// their own second person (so no roster secondary should be assigned)?
export const bringsOwnSecondTech = isSecondaryIneligibleName;
