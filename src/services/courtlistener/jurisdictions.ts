/**
 * @fileoverview CourtListener's `Court.JURISDICTIONS` choice set — the values the
 * `/courts/` `jurisdiction` filter accepts, each with upstream's own label. Upstream
 * declares the filter as `MultipleChoiceFilter(choices=Court.JURISDICTIONS)`, so a
 * value outside the set is a 400 rather than an empty result: the set has to be
 * mirrored exactly, and every surface that names a code reads it from here.
 * @module services/courtlistener/jurisdictions
 */

/**
 * Every jurisdiction code the filter accepts, grouped by court family (upstream's own
 * declaration order interleaves State Attorney General with the territory codes).
 *
 * `T` (Testing) is deliberately absent: `CourtViewSet.queryset` excludes testing courts
 * from every response, so the filter accepts the value and can only ever match zero rows.
 */
export const COURT_JURISDICTION_CODES = [
  'F',
  'FD',
  'FB',
  'FBP',
  'FS',
  'S',
  'SA',
  'ST',
  'SS',
  'SAG',
  'TRS',
  'TRA',
  'TRT',
  'TRX',
  'TS',
  'TA',
  'TT',
  'TSP',
  'MA',
  'MT',
  'C',
  'I',
] as const;

/** One of the jurisdiction codes `/courts/` accepts as a filter value. */
export type JurisdictionCode = (typeof COURT_JURISDICTION_CODES)[number];

/**
 * Upstream's label for each code, verbatim from `Court.JURISDICTIONS`. Carries `T`
 * (Testing) as well, which is not filterable but is still one of upstream's own choices —
 * the difference between a code this server declines to offer and a stored value that
 * matches no choice at all.
 */
export const COURT_JURISDICTION_LABELS: Record<JurisdictionCode | 'T', string> = {
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
