/**
 * @fileoverview Tests for the lookup-citation tool.
 * @module tests/tools/lookup-citation.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupCitationTool } from '@/mcp-server/tools/definitions/lookup-citation.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';
import { captureError } from '../helpers/capture-error.js';

const mockSvc = {
  lookupCitation: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

/** A resolved cluster as the service now hands it back, with the court backfilled. */
function cluster(overrides: Record<string, unknown> = {}) {
  return {
    cluster_id: 108713,
    case_name: 'Roe v. Wade',
    court: 'Supreme Court of the United States',
    court_id: 'scotus',
    court_resolution: 'resolved',
    date_filed: '1973-01-22',
    docket_id: 488071,
    citations: ['410 U.S. 113', '93 S. Ct. 705'],
    cite_count: 5585,
    precedential_status: 'Published',
    judges: 'Blackmun, Burger, Douglas',
    ...overrides,
  };
}

describe('lookupCitationTool', () => {
  it('resolves a valid citation string', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue([
      {
        citation: '410 U.S. 113',
        normalized_citation: '410 U.S. 113',
        status: 200,
        error_message: '',
        clusters: [cluster()],
      },
    ]);
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({ citation: '410 U.S. 113' });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.matches).toHaveLength(1);
    const match = result.matches[0]!;
    expect(match.status).toBe(200);
    expect(match.status_label).toBe('Resolved to one case');
    expect(match.normalized_citation).toBe('410 U.S. 113');
    expect(match.clusters[0]!.cluster_id).toBe(108713);
    expect(match.clusters[0]!.case_name).toBe('Roe v. Wade');
    expect(match.clusters[0]!.citations).toContain('410 U.S. 113');
    expect(() => lookupCitationTool.output.parse(result)).not.toThrow();

    const enrichment = getEnrichment(ctx);
    expect(enrichment.queriedCitation).toBe('410 U.S. 113');
    expect(enrichment.notice).toBeUndefined();
  });

  // #50 — the cluster embedded in /citation-lookup/ has no court field at any nesting
  // level, so the old `cluster.court ?? null` read produced court: null on every single
  // successful lookup while the schema documented it as "null if not found".
  it('surfaces the court backfilled from the cluster docket (#50)', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue([
      {
        citation: '410 U.S. 113',
        normalized_citation: '410 U.S. 113',
        status: 200,
        error_message: '',
        clusters: [cluster()],
      },
    ]);
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({ citation: '410 U.S. 113' });
    const result = await lookupCitationTool.handler(input, ctx);

    const resolved = result.matches[0]!.clusters[0]!;
    expect(resolved.court).toBe('Supreme Court of the United States');
    expect(resolved.court_id).toBe('scotus');
    // Free metadata the old flat shape discarded — chainable without a second request.
    expect(resolved.docket_id).toBe(488071);
    expect(resolved.cite_count).toBe(5585);
    expect(resolved.precedential_status).toBe('Published');
    expect(resolved.judges).toBe('Blackmun, Burger, Douglas');
  });

  it('reports a null court when the docket backfill did not resolve (#50)', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue([
      {
        citation: '1 F.3d 1',
        normalized_citation: '1 F.3d 1',
        status: 200,
        error_message: '',
        clusters: [
          cluster({ court: null, court_id: null, court_resolution: 'no_docket', docket_id: null }),
        ],
      },
    ]);
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({ citation: '1 F.3d 1' });
    const result = await lookupCitationTool.handler(input, ctx);

    const resolved = result.matches[0]!.clusters[0]!;
    expect(resolved.court).toBeNull();
    expect(resolved.court_id).toBeNull();
    // A failed backfill must not fail the lookup — the citation still resolved.
    expect(resolved.cluster_id).toBe(108713);
    expect(() => lookupCitationTool.output.parse(result)).not.toThrow();
    // No docket to resolve from, so nothing was withheld — no caveat to report.
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  // Court resolution is budgeted per call, and the budget is a server-side decision: a
  // cluster that carries a docket but no court_id looks identical to one with no court
  // at all. The response has to say so, or the caller never learns the difference.
  //
  // #66 — and the two causes carry different advice: a bounded-out cluster resolves on a
  // larger budget, an attempted-and-failed one does not. One aggregate count told the
  // caller to retry work that will fail again.
  it('reports bounded-out and failed court lookups as separate causes (#66)', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue([
      {
        citation: '410 U.S. 113',
        normalized_citation: '410 U.S. 113',
        status: 200,
        error_message: '',
        clusters: [cluster()],
      },
      {
        citation: '1 F.3d 1',
        normalized_citation: '1 F.3d 1',
        status: 200,
        error_message: '',
        clusters: [
          cluster({
            cluster_id: 2,
            court: null,
            court_id: null,
            court_resolution: 'over_budget',
            docket_id: 900,
          }),
        ],
      },
      {
        citation: '2 F.3d 2',
        normalized_citation: '2 F.3d 2',
        status: 200,
        error_message: '',
        clusters: [
          cluster({
            cluster_id: 3,
            court: null,
            court_id: null,
            court_resolution: 'lookup_failed',
            docket_id: 901,
          }),
        ],
      },
    ]);
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({ citation: 'a passage' });
    await lookupCitationTool.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    // One bounded out (raising the budget helps) and one attempted-and-failed (it does not).
    expect(notice).toContain('Court unresolved on 1 of the returned clusters because');
    expect(notice).toContain('Raise max_court_lookups');
    expect(notice).toContain('Raising max_court_lookups will not change these');
    expect(notice).toContain('courtlistener_get_docket');
    // Citations did resolve, so the not-found recovery hint must not be mixed in.
    expect(notice).not.toContain('No citation in');
  });

  // #66 — the budget was a hardcoded constant with no caller control, so a caller who
  // needed no court names still paid for four docket lookups.
  it('threads the caller-supplied court-lookup budget through to the service (#66)', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue([]);
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citation: '410 U.S. 113',
      max_court_lookups: 0,
    });
    await lookupCitationTool.handler(input, ctx);
    expect(mockSvc.lookupCitation).toHaveBeenCalledWith('410 U.S. 113', 0, ctx);
  });

  it('defaults the court-lookup budget and rejects one past the ceiling (#66)', async () => {
    expect(lookupCitationTool.input.parse({ citation: '410 U.S. 113' }).max_court_lookups).toBe(4);
    expect(() =>
      lookupCitationTool.input.parse({ citation: '410 U.S. 113', max_court_lookups: 21 }),
    ).toThrow();
    expect(() =>
      lookupCitationTool.input.parse({ citation: '410 U.S. 113', max_court_lookups: -1 }),
    ).toThrow();
  });

  // #50 — upstream extracts every citation in the submitted text and returns one entry
  // each; the old service read result[0].clusters[0] and dropped the rest silently.
  it('returns every citation found, not just the first (#50)', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue([
      {
        citation: '410 U.S. 113',
        normalized_citation: '410 U.S. 113',
        status: 200,
        error_message: '',
        clusters: [cluster()],
      },
      {
        citation: '347 U.S. 483',
        normalized_citation: '347 U.S. 483',
        status: 200,
        error_message: '',
        clusters: [cluster({ cluster_id: 105221, case_name: 'Brown v. Board of Education' })],
      },
    ]);
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({
      citation: 'See 410 U.S. 113 and 347 U.S. 483.',
    });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.matches.map((m) => m.citation)).toEqual(['410 U.S. 113', '347 U.S. 483']);
    expect(result.matches[1]!.clusters[0]!.case_name).toBe('Brown v. Board of Education');
  });

  // #50 — a 300 (several candidate clusters for one citation) was indistinguishable from
  // a clean single hit, because only clusters[0] was ever read.
  it('distinguishes an ambiguous citation from a clean hit (#50)', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue([
      {
        citation: '1 U.S. 1',
        normalized_citation: '1 U.S. 1',
        status: 300,
        error_message: '',
        clusters: [cluster({ cluster_id: 1, case_name: 'First Case' }), cluster({ cluster_id: 2 })],
      },
    ]);
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({ citation: '1 U.S. 1' });
    const result = await lookupCitationTool.handler(input, ctx);

    const match = result.matches[0]!;
    expect(match.status).toBe(300);
    expect(match.status_label).toBe('Ambiguous — several candidate cases');
    expect(match.clusters).toHaveLength(2);
  });

  it('carries per-citation status and error_message for an unresolved citation (#50)', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue([
      {
        citation: '999 F.3d 1',
        normalized_citation: '999 F.3d 1',
        status: 404,
        error_message: "Citation not found: '999 F.3d 1'",
        clusters: [],
      },
    ]);
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({ citation: '999 F.3d 1' });
    const result = await lookupCitationTool.handler(input, ctx);

    const match = result.matches[0]!;
    expect(match.status).toBe(404);
    expect(match.status_label).toBe('No case found for this citation');
    expect(match.error_message).toBe("Citation not found: '999 F.3d 1'");
    expect(match.clusters).toEqual([]);
  });

  it('passes an unmapped status code through as its own label', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue([
      {
        citation: '1 F.3d 1',
        normalized_citation: null,
        status: 418,
        error_message: 'unexpected',
        clusters: [],
      },
    ]);
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({ citation: '1 F.3d 1' });
    const result = await lookupCitationTool.handler(input, ctx);
    expect(result.matches[0]!.status_label).toBe('418');
  });

  it('throws not_found when no citation could be parsed from the input', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockSvc.lookupCitation = vi
      .fn()
      .mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'No citation could be parsed'));
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({ citation: 'not a citation' });
    await expect(lookupCitationTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('enriches queriedCitation and a notice when nothing resolved', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue([
      {
        citation: '999 F.3d 1',
        normalized_citation: '999 F.3d 1',
        status: 404,
        error_message: "Citation not found: '999 F.3d 1'",
        clusters: [],
      },
    ]);
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({ citation: '999 F.3d 1' });
    await lookupCitationTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.queriedCitation).toBe('999 F.3d 1');
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('999 F.3d 1');
    // The notice names why each citation failed rather than a generic miss.
    expect(enrichment.notice).toContain('No case found for this citation');
  });

  it('adds no notice when at least one citation resolved', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue([
      {
        citation: '410 U.S. 113',
        normalized_citation: '410 U.S. 113',
        status: 200,
        error_message: '',
        clusters: [cluster()],
      },
      {
        citation: '999 F.3d 1',
        normalized_citation: '999 F.3d 1',
        status: 404,
        error_message: 'Citation not found',
        clusters: [],
      },
    ]);
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({ citation: '410 U.S. 113; 999 F.3d 1' });
    await lookupCitationTool.handler(input, ctx);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  // #39 — a whitespace-only citation previously reached the /citation-lookup/
  // endpoint and spent one of the 125 daily requests on input that cannot resolve.
  describe('empty citation (#39)', () => {
    it('trims citation to empty and rejects without calling the service', async () => {
      mockSvc.lookupCitation = vi.fn();
      const ctx = createMockContext({ errors: lookupCitationTool.errors });
      const input = lookupCitationTool.input.parse({ citation: '   ' });
      expect(input.citation).toBe('');

      const err = await captureError(() => lookupCitationTool.handler(input, ctx));
      expect(err).toMatchObject({ data: { reason: 'empty_citation' } });
      expect(err.message).toContain('citation');
      expect(mockSvc.lookupCitation).not.toHaveBeenCalled();
    });

    // CourtListener caps the submitted text at 64,000 characters, so an oversized
    // passage is refused upstream after the request is already spent.
    it('rejects a passage past the upstream character ceiling without calling the service', async () => {
      mockSvc.lookupCitation = vi.fn();
      const ctx = createMockContext({ errors: lookupCitationTool.errors });
      const input = lookupCitationTool.input.parse({ citation: 'x'.repeat(64_001) });

      const err = await captureError(() => lookupCitationTool.handler(input, ctx));
      expect(err).toMatchObject({ data: { reason: 'citation_too_long' } });
      // The message names the actual ceiling so a caller can trim rather than guess.
      expect(err.message).toContain('64000');
      expect(mockSvc.lookupCitation).not.toHaveBeenCalled();
    });

    it('accepts a passage exactly at the ceiling', async () => {
      mockSvc.lookupCitation = vi.fn().mockResolvedValue([]);
      const ctx = createMockContext({ errors: lookupCitationTool.errors });
      const input = lookupCitationTool.input.parse({ citation: 'x'.repeat(64_000) });

      await lookupCitationTool.handler(input, ctx);
      expect(mockSvc.lookupCitation).toHaveBeenCalled();
    });

    it('trims incidental padding from an otherwise-valid citation', async () => {
      mockSvc.lookupCitation = vi.fn().mockResolvedValue([
        {
          citation: '410 U.S. 113',
          normalized_citation: '410 U.S. 113',
          status: 200,
          error_message: '',
          clusters: [cluster()],
        },
      ]);
      const ctx = createMockContext({ errors: lookupCitationTool.errors });
      const input = lookupCitationTool.input.parse({ citation: '  410 U.S. 113  ' });
      await lookupCitationTool.handler(input, ctx);
      expect(mockSvc.lookupCitation).toHaveBeenCalledWith('410 U.S. 113', 4, ctx);
    });
  });

  it('formats a found citation with cluster_id, court, and the free metadata', () => {
    const output = lookupCitationTool.output.parse({
      matches: [
        {
          citation: '410 U.S. 113',
          normalized_citation: '410 U.S. 113',
          status: 200,
          status_label: 'Resolved to one case',
          error_message: '',
          clusters: [cluster()],
        },
      ],
    });
    const text = (lookupCitationTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('108713');
    expect(text).toContain('Roe v. Wade');
    expect(text).toContain('410 U.S. 113');
    // #50 — court reached content[] as nothing at all before, because it was always null.
    expect(text).toContain('Supreme Court of the United States');
    expect(text).toContain('scotus');
    expect(text).toContain('488071');
    expect(text).toContain('5585');
    expect(text).toContain('Published');
    expect(text).toContain('Blackmun, Burger, Douglas');
    expect(text).toContain('Resolved to one case');
  });

  // #66 — content[] clients see only format() output, so the cause of a null court has
  // to reach that surface too, not just structuredContent.
  it('renders why a court went unresolved in content[] (#66)', () => {
    const output = lookupCitationTool.output.parse({
      matches: [
        {
          citation: '1 F.3d 1',
          normalized_citation: '1 F.3d 1',
          status: 200,
          status_label: 'Resolved to one case',
          error_message: '',
          clusters: [cluster({ court: null, court_id: null, court_resolution: 'over_budget' })],
        },
      ],
    });
    const text = (lookupCitationTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('unresolved');
    expect(text).toContain('over_budget');
  });

  it('formats every match in a multi-citation response (#50)', () => {
    const output = lookupCitationTool.output.parse({
      matches: [
        {
          citation: '410 U.S. 113',
          normalized_citation: '410 U.S. 113',
          status: 200,
          status_label: 'Resolved to one case',
          error_message: '',
          clusters: [cluster()],
        },
        {
          citation: '347 U.S. 483',
          normalized_citation: '347 U.S. 483',
          status: 200,
          status_label: 'Resolved to one case',
          error_message: '',
          clusters: [cluster({ cluster_id: 105221, case_name: 'Brown v. Board of Education' })],
        },
      ],
    });
    const text = (lookupCitationTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('Roe v. Wade');
    expect(text).toContain('Brown v. Board of Education');
    expect(text).toContain('105221');
  });

  it('formats an unresolved match with its status and upstream message', () => {
    const output = lookupCitationTool.output.parse({
      matches: [
        {
          citation: '999 F.3d 1',
          normalized_citation: '999 F.3d 1',
          status: 404,
          status_label: 'No case found for this citation',
          error_message: "Citation not found: '999 F.3d 1'",
          clusters: [],
        },
      ],
    });
    const text = (lookupCitationTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('No case found for this citation');
    expect(text).toContain("Citation not found: '999 F.3d 1'");
    expect(text).toContain('No matching case');
  });

  it('formats an empty match list without throwing', () => {
    const output = lookupCitationTool.output.parse({ matches: [] });
    const text = (lookupCitationTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('No citations were extracted');
  });
});
