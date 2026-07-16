/**
 * @fileoverview Tests for the ISO 8601 calendar-date validation helpers (#40).
 * @module tests/service/dates.test
 */

import { describe, expect, it } from 'vitest';
import { findInvalidDates, isIsoDate } from '@/services/courtlistener/dates.js';

describe('isIsoDate', () => {
  it('accepts real ISO 8601 calendar dates', () => {
    expect(isIsoDate('2020-01-01')).toBe(true);
    expect(isIsoDate('1973-01-22')).toBe(true);
    expect(isIsoDate('2020-02-29')).toBe(true); // 2020 is a leap year
    expect(isIsoDate('2020-12-31')).toBe(true);
  });

  it('rejects non-dates', () => {
    expect(isIsoDate('banana')).toBe(false);
    expect(isIsoDate('')).toBe(false);
  });

  it('rejects values that pass a digit-shape check but are not calendar dates', () => {
    // Each of these matches /^\d{4}-\d{2}-\d{2}$/ yet CourtListener 400s on them,
    // so a shape-only regex would let them through to a wasted request.
    expect(isIsoDate('2020-13-45')).toBe(false); // month 13, day 45
    expect(isIsoDate('2020-02-31')).toBe(false); // February has no 31st
    expect(isIsoDate('2021-02-29')).toBe(false); // 2021 is not a leap year
    expect(isIsoDate('2020-00-10')).toBe(false); // month 0
    expect(isIsoDate('2020-04-31')).toBe(false); // April has 30 days
  });

  it('rejects non-ISO orderings and datetime forms', () => {
    expect(isIsoDate('01-01-2020')).toBe(false);
    expect(isIsoDate('2020/01/01')).toBe(false);
    expect(isIsoDate('2020-1-1')).toBe(false);
    expect(isIsoDate('2020-01-01T00:00:00Z')).toBe(false);
  });
});

describe('findInvalidDates', () => {
  it('returns an empty list when every supplied date is valid', () => {
    expect(findInvalidDates({ filed_after: '2020-01-01', filed_before: '2021-01-01' })).toEqual([]);
  });

  it('skips omitted fields', () => {
    expect(findInvalidDates({ filed_after: undefined, filed_before: undefined })).toEqual([]);
  });

  it('names each invalid field with its value', () => {
    expect(findInvalidDates({ filed_after: '2020-01-01', filed_before: 'banana' })).toEqual([
      'filed_before="banana"',
    ]);
    expect(findInvalidDates({ argued_after: '2020-13-45', argued_before: '2020-02-31' })).toEqual([
      'argued_after="2020-13-45"',
      'argued_before="2020-02-31"',
    ]);
  });
});
