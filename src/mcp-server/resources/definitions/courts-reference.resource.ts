/**
 * @fileoverview Static reference resource listing CourtListener jurisdiction codes and court type guide.
 * @module mcp-server/resources/definitions/courts-reference.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import {
  COURT_JURISDICTION_CODES,
  COURT_JURISDICTION_LABELS,
} from '@/services/courtlistener/jurisdictions.js';

const COURTS_REFERENCE_URI = 'courtlistener://reference/courts';

/**
 * Rendered from the same choice set the `jurisdiction` input validates against, so the
 * guide a model reads before building a query cannot disagree with what the tool accepts.
 */
const JURISDICTION_TABLE = COURT_JURISDICTION_CODES.map(
  (code) => `| ${code} | ${COURT_JURISDICTION_LABELS[code]} |`,
).join('\n');

const COURTS_REFERENCE_CONTENT = `# CourtListener Court Reference

## Jurisdiction Type Codes

Verbatim from CourtListener's \`Court.JURISDICTIONS\`. These are the values \`courtlistener_lookup_courts\`
accepts for \`jurisdiction\`; anything else is rejected by the API as an invalid choice rather than
returning an empty result. Upstream's \`T\` (Testing) code is excluded — \`/courts/\` filters those
courts out of every response, so it can only ever match nothing.

| Code | Description |
|:-----|:------------|
${JURISDICTION_TABLE}

## Common Court IDs

| Court ID | Court Name |
|:---------|:-----------|
| scotus | Supreme Court of the United States |
| ca1 | First Circuit Court of Appeals |
| ca2 | Second Circuit Court of Appeals |
| ca3 | Third Circuit Court of Appeals |
| ca4 | Fourth Circuit Court of Appeals |
| ca5 | Fifth Circuit Court of Appeals |
| ca6 | Sixth Circuit Court of Appeals |
| ca7 | Seventh Circuit Court of Appeals |
| ca8 | Eighth Circuit Court of Appeals |
| ca9 | Ninth Circuit Court of Appeals |
| ca10 | Tenth Circuit Court of Appeals |
| ca11 | Eleventh Circuit Court of Appeals |
| cadc | D.C. Circuit Court of Appeals |
| cafc | Federal Circuit Court of Appeals |
| dcd | D.C. District Court |
| nysd | S.D.N.Y. (Southern District of New York) |
| nyed | E.D.N.Y. (Eastern District of New York) |
| cacd | C.D. Cal. (Central District of California) |
| casd | S.D. Cal. (Southern District of California) |
| cand | N.D. Cal. (Northern District of California) |
| txsd | S.D. Tex. (Southern District of Texas) |
| txnd | N.D. Tex. (Northern District of Texas) |
| deb | D. Del. Bankr. (Delaware Bankruptcy) |
| ilnd | N.D. Ill. (Northern District of Illinois) |
| wawd | W.D. Wash. (Western District of Washington) |

## Rate Limit Reference

CourtListener publishes these limits for its free tier. Actual limits vary by token tier, so
treat the figures as a planning guide rather than a measured ceiling — the authoritative number
is the Retry-After returned on a 429.

| Window | Published free-tier limit |
|:-------|:--------------------------|
| Per minute | 5 requests |
| Per hour | 50 requests |
| Per day | 125 requests |

All three windows apply simultaneously. The most restrictive active throttle controls.

## Search Type Codes

| Code | Data |
|:-----|:-----|
| o | Opinion clusters |
| r | Federal dockets with nested documents |
| d | Federal dockets without document metadata |
| p | Judges/people |
| oa | Oral argument audio |

## Weekly Maintenance Window

CourtListener has a weekly maintenance window: **Thursdays 21:00–23:59 PT**.
Requests during this window may return HTML error pages or 503 responses.
`;

export const courtsReferenceResource = resource(COURTS_REFERENCE_URI, {
  name: 'CourtListener Reference',
  description:
    'Static reference guide for CourtListener court IDs, jurisdiction type codes, search type codes, and rate limit information. Read this before building queries to find the correct court ID and jurisdiction filter values.',
  mimeType: 'text/markdown',
  params: z.object({}),

  // The whole document is compiled into the build — jurisdiction tables, the court-name
  // snapshot, the rate-limit notes — so it cannot change until the server is redeployed.
  // Nothing here is tenant- or caller-specific, so a shared cache may hold it.
  // 2026-07-28 clients only; 2025-era reads are unaffected.
  cacheHint: { ttlMs: 86_400_000, cacheScope: 'public' },

  handler(_params, ctx) {
    ctx.log.debug('courtlistener://reference/courts accessed');
    return COURTS_REFERENCE_CONTENT;
  },

  list: async () => ({
    resources: [
      {
        uri: COURTS_REFERENCE_URI,
        name: 'CourtListener Reference',
        description: 'Court IDs, jurisdiction codes, search type codes, and rate limit reference.',
        mimeType: 'text/markdown',
      },
    ],
  }),
});
