/**
 * @fileoverview Resolves CourtListener court identifiers to human-readable
 * display names. The `/clusters/` and `/dockets/` detail endpoints return the
 * court as a resource URI rather than a name, and the linked `court_id` (e.g.
 * "scotus", "ca9") is the stable identifier used for filtering. This map covers
 * the high-frequency federal appellate courts; any other identifier (district,
 * bankruptcy, state) falls back to the `court_id` itself — the value
 * CourtListener uses for downstream filtering. Resolution is local: no extra
 * API call, which matters under the free-tier rate limit (5 req/min).
 * @module services/courtlistener/court-names
 */

/** Federal appellate court id → official CourtListener `full_name`. */
export const COURT_NAMES: Record<string, string> = {
  scotus: 'Supreme Court of the United States',
  ca1: 'Court of Appeals for the First Circuit',
  ca2: 'Court of Appeals for the Second Circuit',
  ca3: 'Court of Appeals for the Third Circuit',
  ca4: 'Court of Appeals for the Fourth Circuit',
  ca5: 'Court of Appeals for the Fifth Circuit',
  ca6: 'Court of Appeals for the Sixth Circuit',
  ca7: 'Court of Appeals for the Seventh Circuit',
  ca8: 'Court of Appeals for the Eighth Circuit',
  ca9: 'Court of Appeals for the Ninth Circuit',
  ca10: 'Court of Appeals for the Tenth Circuit',
  ca11: 'Court of Appeals for the Eleventh Circuit',
  cadc: 'Court of Appeals for the D.C. Circuit',
  cafc: 'Court of Appeals for the Federal Circuit',
};

/**
 * Resolve a court identifier to its display name.
 * Returns the mapped full name for known federal appellate courts, otherwise
 * the identifier itself (still meaningful — it is the filterable court id).
 * Returns an empty string when no identifier is available.
 */
export function resolveCourtName(courtId: string | null | undefined): string {
  if (!courtId) return '';
  return COURT_NAMES[courtId] ?? courtId;
}
