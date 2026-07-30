/**
 * @fileoverview Resolves CourtListener court identifiers to human-readable
 * display names and answers "what courts exist" without a request. The
 * `/clusters/` and `/dockets/` detail endpoints return the court as a resource
 * URI rather than a name, and the linked `court_id` (e.g. "scotus", "ca9",
 * "nysd") is the stable identifier used for filtering. Both operations read a
 * generated snapshot of every CourtListener court — active and historical —
 * because `/courts/` serves a fixed 20 rows per page and ignores `page_size`,
 * putting a full enumeration (~168 requests) past a day's published free-tier
 * allowance. The live `/courts/` path stays authoritative for complete court
 * records; the snapshot covers ids, names, and the filters below.
 * @module services/courtlistener/court-names
 */

import { COURT_ATTRIBUTES, COURT_FULL_NAMES } from './court-names-data.js';
import { COURT_JURISDICTION_LABELS } from './jurisdictions.js';

/**
 * Resolve a court identifier to its display name.
 * Returns the official `full_name` for known courts, otherwise the identifier
 * itself (still meaningful — it is the filterable court id). Returns an empty
 * string when no identifier is available.
 */
export function resolveCourtName(courtId: string | null | undefined): string {
  if (!courtId) return '';
  return COURT_FULL_NAMES[courtId] ?? courtId;
}

/**
 * Every court id in the snapshot matching the given filters, sorted. The filters
 * mirror `/courts/`'s own — omitting one leaves that dimension unconstrained —
 * so the result is the complete set a paged live enumeration would return, minus
 * whatever has changed upstream since `COURT_SNAPSHOT_DATE`.
 */
export function listSnapshotCourtIds(filters: {
  jurisdiction?: string | undefined;
  in_use?: boolean | undefined;
  has_opinion_scraper?: boolean | undefined;
}): string[] {
  return Object.entries(COURT_ATTRIBUTES)
    .filter(
      ([, attrs]) =>
        (filters.jurisdiction === undefined || attrs.jurisdiction === filters.jurisdiction) &&
        (filters.in_use === undefined || attrs.in_use === filters.in_use) &&
        (filters.has_opinion_scraper === undefined ||
          attrs.has_opinion_scraper === filters.has_opinion_scraper),
    )
    .map(([id]) => id)
    .sort();
}

/**
 * Snapshot court ids whose stored `jurisdiction` is not one of upstream's own choices —
 * currently a lone `"St"` and an empty string. Since a filter can only be given a value
 * from that choice set (`/courts/` answers anything else with a 400), no jurisdiction
 * filter reaches these courts at all. They stay reachable by id, and appear in a listing
 * with no jurisdiction filter.
 */
export function listUnclassifiedCourtIds(): string[] {
  return Object.entries(COURT_ATTRIBUTES)
    .filter(([, attrs]) => !Object.hasOwn(COURT_JURISDICTION_LABELS, attrs.jurisdiction))
    .map(([id]) => id)
    .sort();
}
