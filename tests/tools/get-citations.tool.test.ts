/**
 * @fileoverview Tests for the get-citations tool.
 * @module tests/tools/get-citations.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCitationsTool } from '@/mcp-server/tools/definitions/get-citations.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';
import { captureError } from '../helpers/capture-error.js';

const mockSvc = {
  getCitedBy: vi.fn(),
  getCiting: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

/**
 * Both directions read `/search/?type=o`, so these rows carry the same nested
 * `opinions[]` shape as the opinion search — the matched excerpt is on the
 * variant, never on the cluster row.
 */
const mockCitingResult = {
  total: 2,
  results: [
    {
      cluster_id: 200,
      caseName: 'Related Case One',
      caseNameFull: '',
      court: 'Ninth Circuit',
      court_id: 'ca9',
      dateFiled: '2000-06-01',
      citation: ['100 F.3d 200'],
      citeCount: 50,
      opinions: [
        {
          id: 900,
          type: 'combined-opinion',
          author_id: null,
          per_curiam: false,
          download_url: null,
          local_path: null,
          cites: [108713],
          snippet: 'relevant excerpt',
        },
      ],
    },
    {
      cluster_id: 201,
      caseName: 'Related Case Two',
      caseNameFull: '',
      court: 'Ninth Circuit',
      court_id: 'ca9',
      dateFiled: '2005-03-15',
      citation: ['200 F.3d 300'],
      citeCount: 30,
      opinions: [
        {
          id: 901,
          type: 'combined-opinion',
          author_id: null,
          per_curiam: false,
          download_url: null,
          local_path: null,
          cites: [],
          snippet: '',
        },
      ],
    },
  ],
  nextCursor: null,
  sourceCaseName: 'Landmark Case',
};

describe('getCitationsTool', () => {
  it('fetches cited_by citations by default', async () => {
    mockSvc.getCitedBy = vi.fn().mockResolvedValue(mockCitingResult);
    const ctx = createMockContext({ errors: getCitationsTool.errors });
    const input = getCitationsTool.input.parse({ cluster_id: 100 });
    const result = await getCitationsTool.handler(input, ctx);

    expect(result.source_cluster_id).toBe(100);
    expect(result.direction).toBe('cited_by');
    // Both directions now thread the name out of the cluster fetch that resolves the
    // opinion IDs — no separate name-only lookup (#58).
    expect(result.source_case_name).toBe('Landmark Case');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.cluster_id).toBe(200);
    expect(result.results[0]!.case_name).toBe('Related Case One');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(2);
  });

  // #43 — snippet was read from the top level of the cluster row, where v4 has no
  // such key, so the citation network came back with no relevance signal at all.
  describe('nested snippet mapping (#43)', () => {
    it('lifts the excerpt out of the nested opinion variant', async () => {
      mockSvc.getCitedBy = vi.fn().mockResolvedValue(mockCitingResult);
      const ctx = createMockContext({ errors: getCitationsTool.errors });
      const input = getCitationsTool.input.parse({ cluster_id: 100 });
      const result = await getCitationsTool.handler(input, ctx);

      expect(result.results[0]!.snippet).toBe('relevant excerpt');
      // A variant with no excerpt still yields an empty string, not undefined.
      expect(result.results[1]!.snippet).toBe('');
    });

    it('applies the same mapping on the citing direction', async () => {
      mockSvc.getCiting = vi.fn().mockResolvedValue({
        total: 1,
        results: [mockCitingResult.results[0]],
        nextCursor: null,
        sourceCaseName: 'Source Opinion',
      });
      const ctx = createMockContext({ errors: getCitationsTool.errors });
      const input = getCitationsTool.input.parse({ cluster_id: 100, direction: 'citing' });
      const result = await getCitationsTool.handler(input, ctx);

      expect(result.results[0]!.snippet).toBe('relevant excerpt');
    });

    it('yields an empty snippet when upstream returns no variants', async () => {
      mockSvc.getCitedBy = vi.fn().mockResolvedValue({
        total: 1,
        results: [{ ...mockCitingResult.results[0], opinions: [] }],
        nextCursor: null,
      });
      const ctx = createMockContext({ errors: getCitationsTool.errors });
      const input = getCitationsTool.input.parse({ cluster_id: 100 });
      const result = await getCitationsTool.handler(input, ctx);

      expect(result.results[0]!.snippet).toBe('');
    });
  });

  it('falls back to the cluster-id placeholder when upstream carries no case name', async () => {
    mockSvc.getCitedBy = vi.fn().mockResolvedValue({ ...mockCitingResult, sourceCaseName: null });
    const ctx = createMockContext({ errors: getCitationsTool.errors });
    const input = getCitationsTool.input.parse({ cluster_id: 100 });
    const result = await getCitationsTool.handler(input, ctx);
    expect(result.source_case_name).toBe('(cluster 100)');
  });

  it('fetches citing direction and threads the source case name', async () => {
    mockSvc.getCiting = vi.fn().mockResolvedValue({
      total: 1,
      results: [mockCitingResult.results[0]],
      nextCursor: null,
      sourceCaseName: 'Source Opinion',
    });
    const ctx = createMockContext({ errors: getCitationsTool.errors });
    const input = getCitationsTool.input.parse({ cluster_id: 100, direction: 'citing' });
    const result = await getCitationsTool.handler(input, ctx);

    expect(result.direction).toBe('citing');
    expect(result.source_case_name).toBe('Source Opinion');
    expect(mockSvc.getCiting).toHaveBeenCalledWith(
      expect.objectContaining({ clusterId: 100 }),
      ctx,
    );
    expect(mockSvc.getCitedBy).not.toHaveBeenCalled();
  });

  it('passes court and filed_after filters', async () => {
    mockSvc.getCitedBy = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext({ errors: getCitationsTool.errors });
    const input = getCitationsTool.input.parse({
      cluster_id: 100,
      court: 'scotus',
      filed_after: '2010-01-01',
    });
    await getCitationsTool.handler(input, ctx);
    expect(mockSvc.getCitedBy).toHaveBeenCalledWith(
      expect.objectContaining({ court: 'scotus', filed_after: '2010-01-01' }),
      ctx,
    );
  });

  it('passes court and filed_after filters on the citing direction too', async () => {
    mockSvc.getCiting = vi
      .fn()
      .mockResolvedValue({ total: 0, results: [], nextCursor: null, sourceCaseName: 'Source' });
    const ctx = createMockContext({ errors: getCitationsTool.errors });
    const input = getCitationsTool.input.parse({
      cluster_id: 100,
      direction: 'citing',
      court: 'scotus',
      filed_after: '2010-01-01',
    });
    await getCitationsTool.handler(input, ctx);
    expect(mockSvc.getCiting).toHaveBeenCalledWith(
      expect.objectContaining({ court: 'scotus', filed_after: '2010-01-01' }),
      ctx,
    );
  });

  // #56 — for "citing" the filters narrow each page after the cited-opinion list is
  // sliced, so a filtered page can come back empty with pages still to walk. Reading that
  // as "no citations" sends the caller to the opposite direction for nothing.
  describe('empty page under filters (#56)', () => {
    it('says more pages remain and names the cursor to continue with', async () => {
      mockSvc.getCiting = vi.fn().mockResolvedValue({
        total: 40,
        results: [],
        nextCursor: '2',
        sourceCaseName: 'Source Opinion',
      });
      const ctx = createMockContext({ errors: getCitationsTool.errors });
      const input = getCitationsTool.input.parse({
        cluster_id: 100,
        direction: 'citing',
        court: 'scotus',
        page_size: 2,
      });
      const result = await getCitationsTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice ?? '';
      expect(notice).toContain('more pages remain');
      expect(notice).toContain('cursor=2');
      expect(notice).toContain('court="scotus"');
      expect(notice).not.toContain('Try the opposite direction');
      expect(result.next_cursor).toBe('2');
      expect(getEnrichment(ctx).totalCount).toBe(40);
    });

    it('reports an exhausted filtered set as no citations found', async () => {
      mockSvc.getCiting = vi.fn().mockResolvedValue({
        total: 40,
        results: [],
        nextCursor: null,
        sourceCaseName: 'Source Opinion',
      });
      const ctx = createMockContext({ errors: getCitationsTool.errors });
      const input = getCitationsTool.input.parse({
        cluster_id: 100,
        direction: 'citing',
        court: 'scotus',
      });
      await getCitationsTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice ?? '';
      expect(notice).toContain('No opinions found cited by cluster 100');
      expect(notice).toContain('Try the opposite direction');
    });

    it('keeps the plain empty-network notice on the cited_by direction', async () => {
      mockSvc.getCitedBy = vi.fn().mockResolvedValue({
        total: 0,
        results: [],
        nextCursor: null,
        sourceCaseName: 'Landmark Case',
      });
      const ctx = createMockContext({ errors: getCitationsTool.errors });
      const input = getCitationsTool.input.parse({ cluster_id: 100, court: 'scotus' });
      await getCitationsTool.handler(input, ctx);

      expect(getEnrichment(ctx).notice).toContain('No opinions found citing cluster 100');
    });
  });

  it('passes the cursor through to getCiting and surfaces the advanced next_cursor (#24)', async () => {
    mockSvc.getCiting = vi.fn().mockResolvedValue({
      total: 5,
      results: [],
      nextCursor: '4',
      sourceCaseName: 'Source Opinion',
    });
    const ctx = createMockContext({ errors: getCitationsTool.errors });
    const input = getCitationsTool.input.parse({
      cluster_id: 100,
      direction: 'citing',
      cursor: '2',
      page_size: 2,
    });
    const result = await getCitationsTool.handler(input, ctx);
    expect(mockSvc.getCiting).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: '2', page_size: 2 }),
      ctx,
    );
    expect(result.next_cursor).toBe('4');
  });

  it('throws when service throws', async () => {
    mockSvc.getCitedBy = vi.fn().mockRejectedValue(new Error('API error'));
    const ctx = createMockContext({ errors: getCitationsTool.errors });
    const input = getCitationsTool.input.parse({ cluster_id: 100 });
    await expect(getCitationsTool.handler(input, ctx)).rejects.toThrow();
  });

  // #40 — filed_after here hits the same /search/ endpoint and the same opaque 400
  // as the search tools, even though the issue's "Affected names" list omitted it.
  describe('invalid date filter (#40)', () => {
    for (const bad of ['banana', '2020-13-45', '2020-02-31']) {
      it(`rejects filed_after="${bad}" without calling the service`, async () => {
        mockSvc.getCitedBy = vi.fn();
        mockSvc.getCiting = vi.fn();
        const ctx = createMockContext({ errors: getCitationsTool.errors });
        const input = getCitationsTool.input.parse({ cluster_id: 100, filed_after: bad });

        const err = await captureError(() => getCitationsTool.handler(input, ctx));
        expect(err).toMatchObject({ data: { reason: 'invalid_date' } });
        expect(err.message).toContain('filed_after');
        expect(err.message).toContain('YYYY-MM-DD');
        expect(mockSvc.getCitedBy).not.toHaveBeenCalled();
        expect(mockSvc.getCiting).not.toHaveBeenCalled();
      });
    }

    it('rejects a malformed filed_after on the citing direction too', async () => {
      mockSvc.getCiting = vi.fn();
      const ctx = createMockContext({ errors: getCitationsTool.errors });
      const input = getCitationsTool.input.parse({
        cluster_id: 100,
        direction: 'citing',
        filed_after: '2021-02-29',
      });

      await expect(getCitationsTool.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'invalid_date' },
      });
      expect(mockSvc.getCiting).not.toHaveBeenCalled();
    });

    it('lets a valid calendar date through to the service', async () => {
      mockSvc.getCitedBy = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
      const ctx = createMockContext({ errors: getCitationsTool.errors });
      const input = getCitationsTool.input.parse({ cluster_id: 100, filed_after: '2020-02-29' });
      await getCitationsTool.handler(input, ctx);
      expect(mockSvc.getCitedBy).toHaveBeenCalledWith(
        expect.objectContaining({ filed_after: '2020-02-29' }),
        ctx,
      );
    });
  });

  it('page_size defaults to 20 and scopes the 20-result floor to cited_by (#33)', () => {
    // default aligns with CourtListener's 20-result floor (mirrors #7)
    expect(getCitationsTool.input.parse({ cluster_id: 100 }).page_size).toBe(20);

    const desc = getCitationsTool.input.shape.page_size.description ?? '';
    expect(desc).toMatch(/minimum of 20/i);
    // the floor is scoped to cited_by; citing is documented as capped at page_size, not floored
    // (getCiting slices the cited-opinion list, so it returns fewer when the source cites less)
    expect(desc).toContain('cited_by');
    expect(desc).toContain('citing');
    // Both directions resolve the source cluster's opinion IDs before searching, so the
    // old "costs one request" claim understated the budget by two (#58).
    expect(desc).toContain('three requests');
    expect(desc).not.toMatch(/costs one request/i);
  });

  it('states the unit and filter status of totalCount for both directions (#56)', () => {
    const desc = getCitationsTool.enrichment?.totalCount.description ?? '';
    expect(desc).toContain('cited_by');
    expect(desc).toContain('citing');
    // Counts opinions on one direction and filtered clusters on the other — silence on
    // that is what let an unfiltered opinion count read as a reachable result total.
    expect(desc).toMatch(/before any filter/i);
    expect(desc).toMatch(/clusters/i);
  });

  it('formats output with source and result details', () => {
    const output = getCitationsTool.output.parse({
      source_cluster_id: 100,
      source_case_name: 'Landmark Case',
      direction: 'cited_by',
      results: [
        {
          cluster_id: 200,
          case_name: 'Related Case',
          court: 'Ninth Circuit',
          court_id: 'ca9',
          date_filed: '2000-01-01',
          citations: ['100 F.3d 200'],
          cite_count: 50,
          snippet: 'excerpt text',
        },
      ],
      next_cursor: null,
    });
    const blocks = getCitationsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('100');
    expect(text).toContain('Related Case');
    expect(text).toContain('ca9');
    expect(text).toContain('Cited By');
  });

  it('format handles empty results', () => {
    const output = getCitationsTool.output.parse({
      source_cluster_id: 100,
      source_case_name: 'Test',
      direction: 'citing',
      results: [],
      next_cursor: null,
    });
    const blocks = getCitationsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No citations');
  });

  it('renders next_cursor on an empty page instead of returning early (#36)', () => {
    const output = getCitationsTool.output.parse({
      source_cluster_id: 100,
      source_case_name: 'Test',
      direction: 'cited_by',
      results: [],
      next_cursor: '4',
    });
    const blocks = getCitationsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No citations');
    // Pre-fix, the empty branch early-returned before the continuation could render.
    expect(text).toContain('Next page cursor');
    expect(text).toContain('4');
  });
});
