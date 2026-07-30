/**
 * @fileoverview Tests for the CourtListener jurisdiction choice set.
 * @module tests/service/jurisdictions.test
 */

import { describe, expect, it } from 'vitest';
import {
  COURT_JURISDICTION_CODES,
  COURT_JURISDICTION_LABELS,
} from '@/services/courtlistener/jurisdictions.js';

/**
 * Verbatim from `Court.JURISDICTIONS` in cl/search/models.py — the table the module under
 * test exists to mirror. Written out independently here so a dropped or reworded choice
 * fails at the source instead of propagating to the tool input and the reference guide,
 * which both render from the module.
 */
const UPSTREAM_CHOICES: Record<string, string> = {
  F: 'Federal Appellate',
  FD: 'Federal District',
  FB: 'Federal Bankruptcy',
  FBP: 'Federal Bankruptcy Panel',
  FS: 'Federal Special',
  S: 'State Supreme',
  SA: 'State Appellate',
  ST: 'State Trial',
  SS: 'State Special',
  SAG: 'State Attorney General',
  TRS: 'Tribal Supreme',
  TRA: 'Tribal Appellate',
  TRT: 'Tribal Trial',
  TRX: 'Tribal Special',
  TS: 'Territory Supreme',
  TA: 'Territory Appellate',
  TT: 'Territory Trial',
  TSP: 'Territory Special',
  MA: 'Military Appellate',
  MT: 'Military Trial',
  C: 'Committee',
  I: 'International',
  T: 'Testing',
};

describe('court jurisdictions (#67)', () => {
  it("labels every upstream choice with upstream's own text", () => {
    expect(COURT_JURISDICTION_LABELS).toEqual(UPSTREAM_CHOICES);
  });

  it('offers every choice except Testing as a filter value', () => {
    // CourtViewSet.queryset excludes Court.TESTING_COURT from every response, so the
    // filter accepts T and can only ever match zero rows.
    expect([...COURT_JURISDICTION_CODES].sort()).toEqual(
      Object.keys(UPSTREAM_CHOICES)
        .filter((code) => code !== 'T')
        .sort(),
    );
  });
});
