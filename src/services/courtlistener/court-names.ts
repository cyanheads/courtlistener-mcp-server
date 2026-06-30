/**
 * @fileoverview Resolves CourtListener court identifiers to human-readable
 * display names. The `/clusters/` and `/dockets/` detail endpoints return the
 * court as a resource URI rather than a name, and the linked `court_id` (e.g.
 * "scotus", "ca9", "nysd") is the stable identifier used for filtering.
 * Resolution is local against a generated snapshot of CourtListener's in-use
 * courts (no extra API call, which matters under the free-tier rate limit of
 * 5 req/min); any identifier absent from the snapshot falls back to the
 * `court_id` itself — the value CourtListener uses for downstream filtering.
 * @module services/courtlistener/court-names
 */

import { COURT_FULL_NAMES } from './court-names-data.js';

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
