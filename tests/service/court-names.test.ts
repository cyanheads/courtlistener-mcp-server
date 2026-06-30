/**
 * @fileoverview Tests for the court-name resolver.
 * @module tests/service/court-names.test
 */

import { describe, expect, it } from 'vitest';
import { resolveCourtName } from '@/services/courtlistener/court-names.js';

describe('resolveCourtName', () => {
  it('resolves federal appellate court ids to full names', () => {
    expect(resolveCourtName('scotus')).toBe('Supreme Court of the United States');
    expect(resolveCourtName('ca9')).toBe('Court of Appeals for the Ninth Circuit');
  });

  it('resolves district and bankruptcy court ids beyond the federal appellate set', () => {
    // The pre-fix map covered only the 14 federal appellate courts; these now
    // resolve to a full name instead of showing the raw court_id.
    expect(resolveCourtName('nysd')).toBe('District Court, S.D. New York');
    expect(resolveCourtName('deb')).toBe('United States Bankruptcy Court, D. Delaware');
  });

  it('resolves a state court id', () => {
    expect(resolveCourtName('cal')).toBe('California Supreme Court');
  });

  it('falls back to the raw id for an unknown court', () => {
    expect(resolveCourtName('zzz-not-a-court')).toBe('zzz-not-a-court');
  });

  it('returns an empty string when no identifier is available', () => {
    expect(resolveCourtName('')).toBe('');
    expect(resolveCourtName(null)).toBe('');
    expect(resolveCourtName(undefined)).toBe('');
  });
});
