/**
 * @fileoverview Expands CourtListener's coded enum columns to readable labels.
 * The detail endpoints (`/people/`, `/positions/`, `/opinions/`, `/parties/`)
 * serve the stored code — `"jud"`, `"030concurrence"`, `2` — while the search
 * endpoints serve the label CourtListener's own tables map it to. Decoding
 * locally costs no extra request (which matters under the free-tier rate limit)
 * and keeps the two surfaces reading the same for the same record.
 * @module services/courtlistener/codes
 */

/**
 * Resolve a code to its label in `labels`, matching case-insensitively — upstream
 * is inconsistent about case on some columns (`"BA"` and `"ba"` both appear).
 * Numeric codes are matched by their string form.
 *
 * An unmapped code passes through unchanged rather than being dropped or guessed:
 * a value CourtListener adds after a table here was written stays visible and
 * usable as a filter argument instead of silently rendering as an empty string.
 * Returns `''` only when there is no code at all.
 *
 * @example
 * expandCode({ jud: 'Judge' }, 'jud')     // 'Judge'
 * expandCode({ jud: 'Judge' }, 'newcode') // 'newcode' — unmapped, passed through
 * expandCode({ jud: 'Judge' }, null)      // ''
 */
export function expandCode(
  labels: Record<string, string>,
  code: string | number | null | undefined,
): string {
  if (code === null || code === undefined || code === '') return '';
  const key = String(code);
  return labels[key.toLowerCase()] ?? key;
}
