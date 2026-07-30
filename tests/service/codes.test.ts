/**
 * @fileoverview Tests for the shared coded-value expander.
 * @module tests/service/codes.test
 */

import { describe, expect, it } from 'vitest';
import { expandCode } from '@/services/courtlistener/codes.js';

const LABELS: Record<string, string> = { jud: 'Judge', '030concurrence': 'concurrence-opinion' };

describe('expandCode', () => {
  it('resolves a known code to its label', () => {
    expect(expandCode(LABELS, 'jud')).toBe('Judge');
    expect(expandCode(LABELS, '030concurrence')).toBe('concurrence-opinion');
  });

  it('matches case-insensitively — upstream is inconsistent on some columns', () => {
    expect(expandCode(LABELS, 'JUD')).toBe('Judge');
  });

  it('passes an unmapped code through unchanged rather than dropping or guessing it', () => {
    expect(expandCode(LABELS, 'not-in-the-table')).toBe('not-in-the-table');
  });

  it('matches a numeric code by its string form', () => {
    expect(expandCode({ 2: 'Lead attorney' }, 2)).toBe('Lead attorney');
    // 0 is a code, not an absent value
    expect(expandCode({ 2: 'Lead attorney' }, 0)).toBe('0');
    expect(expandCode({ 2: 'Lead attorney' }, 99)).toBe('99');
  });

  it('returns an empty string only when there is no code', () => {
    expect(expandCode(LABELS, '')).toBe('');
    expect(expandCode(LABELS, null)).toBe('');
    expect(expandCode(LABELS, undefined)).toBe('');
  });
});
