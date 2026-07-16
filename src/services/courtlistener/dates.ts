/**
 * @fileoverview Validate the ISO 8601 date filters the search tools forward to
 * CourtListener. The `/search/` endpoint rejects a malformed date with an opaque
 * `400 {"detail":"The date entered has an invalid format."}`, so the tools check
 * locally first and spend no request on input that cannot succeed.
 * @module services/courtlistener/dates
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * Real calendar validation, not digit-grouping: `2020-13-45` and `2020-02-31`
 * match a `\d{4}-\d{2}-\d{2}` shape check but are not dates, and CourtListener
 * rejects them exactly like `banana`. Zod's ISO date format is leap-year aware
 * and per-month day-bounded, so it rules both out.
 */
const ISO_DATE = z.iso.date();

/** The accepted format, quoted back to the agent on rejection. */
export const ISO_DATE_HINT =
  'Dates must be ISO 8601 calendar dates (YYYY-MM-DD), e.g. "2020-01-01".';

/**
 * True when `value` is a valid ISO 8601 calendar date.
 *
 * @example
 * isIsoDate('2020-01-01')  // true
 * isIsoDate('2020-13-45')  // false — month 13, day 45
 * isIsoDate('2021-02-29')  // false — 2021 is not a leap year
 */
export function isIsoDate(value: string): boolean {
  return ISO_DATE.safeParse(value).success;
}

/**
 * Describes each date field whose value isn't a valid ISO 8601 calendar date,
 * as `field="value"` fragments ready to interpolate into an error message.
 * Omitted (`undefined`) fields are skipped; returns `[]` when all are valid.
 *
 * @example
 * findInvalidDates({ filed_after: '2020-01-01', filed_before: 'banana' })
 * // ['filed_before="banana"']
 */
export function findInvalidDates(fields: Record<string, string | undefined>): string[] {
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && !isIsoDate(value))
    .map(([field, value]) => `${field}="${value}"`);
}
