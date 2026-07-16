/**
 * @fileoverview Tests for the search-opinions tool.
 * @module tests/tools/search-opinions.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchOpinionsTool } from '@/mcp-server/tools/definitions/search-opinions.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';

const mockSvc = {
  searchOpinions: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

const baseResult = {
  total: 2,
  results: [
    {
      cluster_id: 100,
      caseName: 'Roe v. Wade',
      caseNameFull: 'Roe v. Wade (Full)',
      court: 'Supreme Court',
      court_id: 'scotus',
      dateFiled: '1973-01-22',
      docketNumber: '70-18',
      docket_id: 5000,
      citation: ['410 U.S. 113'],
      citeCount: 10000,
      judge: 'Blackmun',
      snippet: 'right of privacy',
      status: 'Published',
    },
    {
      cluster_id: 101,
      caseName: 'Planned Parenthood v. Casey',
      caseNameFull: 'Planned Parenthood of S.E. Pa. v. Casey',
      court: 'Supreme Court',
      court_id: 'scotus',
      dateFiled: '1992-06-29',
      docketNumber: '91-744',
      docket_id: 5001,
      citation: ['505 U.S. 833'],
      citeCount: 5000,
      judge: "O'Connor",
      snippet: 'undue burden standard',
      status: 'Published',
    },
  ],
  nextCursor: null,
};

describe('searchOpinionsTool', () => {
  it('returns mapped opinion summaries and enriches total + echo for valid input', async () => {
    mockSvc.searchOpinions = vi.fn().mockResolvedValue(baseResult);
    const ctx = createMockContext();
    const input = searchOpinionsTool.input.parse({ q: 'abortion rights' });
    const result = await searchOpinionsTool.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      cluster_id: 100,
      case_name: 'Roe v. Wade',
      case_name_full: 'Roe v. Wade (Full)',
      court: 'Supreme Court',
      court_id: 'scotus',
    });
    expect(result.next_cursor).toBeNull();

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(2);
    expect(enrichment.effectiveQuery).toBe('abortion rights');
    expect(enrichment.notice).toBeUndefined();
  });

  it('passes optional filters to service', async () => {
    mockSvc.searchOpinions = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchOpinionsTool.input.parse({
      q: 'test query',
      court: 'scotus',
      filed_after: '2020-01-01',
      status: 'Published',
    });
    await searchOpinionsTool.handler(input, ctx);
    expect(mockSvc.searchOpinions).toHaveBeenCalledWith(
      expect.objectContaining({ court: 'scotus', filed_after: '2020-01-01', status: 'Published' }),
      ctx,
    );
  });

  it('enriches notice on empty results', async () => {
    mockSvc.searchOpinions = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchOpinionsTool.input.parse({ q: 'no match query xyz123' });
    const result = await searchOpinionsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('no match query xyz123');
  });

  it('throws when service throws', async () => {
    mockSvc.searchOpinions = vi.fn().mockRejectedValue(new Error('rate limit'));
    const ctx = createMockContext();
    const input = searchOpinionsTool.input.parse({ q: 'test' });
    await expect(searchOpinionsTool.handler(input, ctx)).rejects.toThrow();
  });

  // #39 — a whitespace-only q previously reached CourtListener, spent one of the
  // 125 daily requests, and came back with 20 unrelated recent opinions.
  describe('empty query (#39)', () => {
    it('trims q to empty and rejects without calling the service', async () => {
      mockSvc.searchOpinions = vi.fn();
      const ctx = createMockContext({ errors: searchOpinionsTool.errors });
      const input = searchOpinionsTool.input.parse({ q: '   ' });
      expect(input.q).toBe('');

      const err = await searchOpinionsTool.handler(input, ctx).catch((e) => e);
      expect(err).toMatchObject({ data: { reason: 'empty_query' } });
      expect(err.message).toContain('q');
      expect(mockSvc.searchOpinions).not.toHaveBeenCalled();
    });

    it('rejects an empty q without calling the service', async () => {
      mockSvc.searchOpinions = vi.fn();
      const ctx = createMockContext({ errors: searchOpinionsTool.errors });
      const input = searchOpinionsTool.input.parse({ q: '' });
      await expect(searchOpinionsTool.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'empty_query' },
      });
      expect(mockSvc.searchOpinions).not.toHaveBeenCalled();
    });

    it('trims incidental padding from an otherwise-valid q', async () => {
      mockSvc.searchOpinions = vi.fn().mockResolvedValue(baseResult);
      const ctx = createMockContext();
      const input = searchOpinionsTool.input.parse({ q: '  qualified immunity  ' });
      await searchOpinionsTool.handler(input, ctx);
      expect(mockSvc.searchOpinions).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'qualified immunity' }),
        ctx,
      );
    });
  });

  // #40 — malformed dates reached the /search/ endpoint and returned an opaque
  // 400 ("The date entered has an invalid format.") with no usable content[].
  describe('invalid date filters (#40)', () => {
    // '2020-13-45' and '2020-02-31' satisfy /^\d{4}-\d{2}-\d{2}$/ but are not
    // calendar dates — CourtListener rejects them exactly like 'banana'.
    for (const bad of ['banana', '2020-13-45', '2020-02-31', '01-01-2020']) {
      it(`rejects filed_after="${bad}" without calling the service`, async () => {
        mockSvc.searchOpinions = vi.fn();
        const ctx = createMockContext({ errors: searchOpinionsTool.errors });
        const input = searchOpinionsTool.input.parse({ q: 'qualified immunity', filed_after: bad });

        const err = await searchOpinionsTool.handler(input, ctx).catch((e) => e);
        expect(err).toMatchObject({ data: { reason: 'invalid_date' } });
        // The message is the surface both content[] and structuredContent.error
        // carry, so the field name and accepted format must live in it.
        expect(err.message).toContain('filed_after');
        expect(err.message).toContain(bad);
        expect(err.message).toContain('YYYY-MM-DD');
        expect(mockSvc.searchOpinions).not.toHaveBeenCalled();
      });
    }

    it('rejects a malformed filed_before without calling the service', async () => {
      mockSvc.searchOpinions = vi.fn();
      const ctx = createMockContext({ errors: searchOpinionsTool.errors });
      const input = searchOpinionsTool.input.parse({ q: 'test', filed_before: '2021-02-29' });

      const err = await searchOpinionsTool.handler(input, ctx).catch((e) => e);
      expect(err).toMatchObject({ data: { reason: 'invalid_date' } });
      expect(err.message).toContain('filed_before');
      expect(mockSvc.searchOpinions).not.toHaveBeenCalled();
    });

    it('lets valid calendar dates through to the service', async () => {
      mockSvc.searchOpinions = vi.fn().mockResolvedValue(baseResult);
      const ctx = createMockContext({ errors: searchOpinionsTool.errors });
      const input = searchOpinionsTool.input.parse({
        q: 'test',
        filed_after: '2020-02-29', // leap day — valid
        filed_before: '2021-01-01',
      });
      await searchOpinionsTool.handler(input, ctx);
      expect(mockSvc.searchOpinions).toHaveBeenCalledWith(
        expect.objectContaining({ filed_after: '2020-02-29', filed_before: '2021-01-01' }),
        ctx,
      );
    });
  });

  it('formats output with required fields', () => {
    const output = searchOpinionsTool.output.parse({
      results: [
        {
          cluster_id: 100,
          case_name: 'Roe v. Wade',
          case_name_full: 'Roe v. Wade (Full)',
          court: 'Supreme Court',
          court_id: 'scotus',
          date_filed: '1973-01-22',
          docket_number: '70-18',
          docket_id: 5000,
          citations: ['410 U.S. 113'],
          cite_count: 10000,
          judges: 'Blackmun',
          status: 'Published',
          snippet: 'right of privacy',
        },
      ],
      next_cursor: null,
    });
    const blocks = searchOpinionsTool.format!(output);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('100');
    expect(text).toContain('Roe v. Wade');
    expect(text).toContain('scotus');
    expect(text).toContain('1973-01-22');
    expect(text).toContain('Published');
    // case_name_full must be rendered for parity
    expect(text).toContain('Roe v. Wade (Full)');
  });

  it('format handles empty results', () => {
    const output = searchOpinionsTool.output.parse({
      results: [],
      next_cursor: null,
    });
    const blocks = searchOpinionsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No opinions matched');
  });

  it('format handles sparse upstream payload — missing optional fields', () => {
    const output = searchOpinionsTool.output.parse({
      results: [
        {
          cluster_id: 200,
          case_name: 'Test Case',
          case_name_full: '',
          court: 'Ninth Circuit',
          court_id: 'ca9',
          date_filed: '2020-06-01',
          docket_number: '20-1234',
          docket_id: 6000,
          citations: [],
          cite_count: 0,
          judges: '',
          status: 'Unpublished',
          snippet: '',
        },
      ],
      next_cursor: null,
    });
    // Should not throw with empty/missing optional fields
    const blocks = searchOpinionsTool.format!(output);
    expect(blocks[0].type).toBe('text');
  });
});
