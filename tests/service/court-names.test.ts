/**
 * @fileoverview Tests for the court-name resolver.
 * @module tests/service/court-names.test
 */

import { describe, expect, it } from 'vitest';
import {
  listSnapshotCourtIds,
  listUnclassifiedCourtIds,
  resolveCourtName,
} from '@/services/courtlistener/court-names.js';
import {
  COURT_ATTRIBUTES,
  COURT_FULL_NAMES,
  COURT_SNAPSHOT_DATE,
} from '@/services/courtlistener/court-names-data.js';
import { COURT_JURISDICTION_LABELS } from '@/services/courtlistener/jurisdictions.js';

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

  // #65 — the snapshot covered only the in-use bench, so a historical court cited in an
  // old opinion rendered as its bare id while every active court got a name.
  it('resolves a historical court the in-use-only snapshot could not (#65)', () => {
    expect(resolveCourtName('calsuppctla')).toBe(
      'Superior Court of California, County of Los Angeles',
    );
    expect(COURT_ATTRIBUTES.calsuppctla?.in_use).toBe(false);
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

describe('court snapshot (#65)', () => {
  it('covers both benches with one entry per court in each table', () => {
    const ids = Object.keys(COURT_FULL_NAMES);
    // The in-use bench alone is ~472 courts; the whole set is several times that.
    expect(ids.length).toBeGreaterThan(3000);
    expect(Object.keys(COURT_ATTRIBUTES)).toEqual(ids);
    expect(COURT_SNAPSHOT_DATE).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('carries enough to split the active bench from the historical one', () => {
    const active = listSnapshotCourtIds({ in_use: true });
    const inactive = listSnapshotCourtIds({ in_use: false });

    expect(active).toContain('scotus');
    expect(inactive).not.toContain('scotus');
    // Disjoint halves that together account for every court — the property upstream's
    // boolean `in_use` filter has, and the reason 'any' is the only complete listing.
    expect(active.length + inactive.length).toBe(Object.keys(COURT_FULL_NAMES).length);
    expect(inactive.length).toBeGreaterThan(active.length);
  });

  it('filters by jurisdiction and scraper coverage the way /courts/ does', () => {
    const federalAppellate = listSnapshotCourtIds({ jurisdiction: 'F', in_use: true });
    expect(federalAppellate).toContain('scotus');
    expect(federalAppellate).toContain('ca9');
    expect(federalAppellate).not.toContain('nysd');

    const scraped = listSnapshotCourtIds({ jurisdiction: 'F', has_opinion_scraper: true });
    expect(scraped.length).toBeLessThan(listSnapshotCourtIds({ jurisdiction: 'F' }).length);
  });

  it('returns every court when no filter is applied, sorted', () => {
    const all = listSnapshotCourtIds({});
    expect(all).toHaveLength(Object.keys(COURT_FULL_NAMES).length);
    expect(all).toEqual([...all].sort());
  });
});

// #67 — two rows store a jurisdiction that is not one of upstream's choices at all: a
// lone "St" (which /courts/ rejects as an invalid filter value) and an empty string.
// Covering every code in Court.JURISDICTIONS still cannot reach them.
describe('listUnclassifiedCourtIds (#67)', () => {
  it('names the courts whose stored jurisdiction matches no upstream choice', () => {
    expect(listUnclassifiedCourtIds()).toEqual(['njcirctsussex', 'ohctapp1']);
  });

  it('reports courts that are in the snapshot but carry no usable jurisdiction', () => {
    const unclassified = listUnclassifiedCourtIds();
    for (const id of unclassified) {
      const stored = COURT_ATTRIBUTES[id]?.jurisdiction ?? '';
      expect(Object.hasOwn(COURT_JURISDICTION_LABELS, stored)).toBe(false);
    }
    // They are still in the snapshot — reachable by id, or by a listing with no filter.
    expect(listSnapshotCourtIds({}).filter((id) => unclassified.includes(id))).toEqual(
      unclassified,
    );
  });
});
