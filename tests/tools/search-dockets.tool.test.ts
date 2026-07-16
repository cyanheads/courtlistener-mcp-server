/**
 * @fileoverview Tests for the search-dockets tool.
 * @module tests/tools/search-dockets.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchDocketsTool } from '@/mcp-server/tools/definitions/search-dockets.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';

const mockSvc = {
  searchDockets: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

const baseDocketResult = {
  total: 1,
  results: [
    {
      docket_id: 8000,
      caseName: 'Apple Inc. v. Samsung Electronics',
      court: 'Northern District of California',
      court_id: 'cand',
      dateFiled: '2011-04-15',
      dateTerminated: '2018-06-27',
      docketNumber: '11-cv-01846',
      pacer_case_id: 'pacer123',
      assignedTo: 'Judge Koh',
      cause: 'Patent Infringement',
      juryDemand: 'Both',
      party_name: ['Apple Inc.', 'Samsung Electronics'],
      document_count: 1500,
      recap_documents: [
        {
          id: 90000,
          description: 'Complaint',
          date_filed: '2011-04-15',
          document_number: 1,
          is_available: true,
        },
      ],
    },
  ],
  nextCursor: null,
};

describe('searchDocketsTool', () => {
  it('returns mapped docket summaries and enriches total for valid input', async () => {
    mockSvc.searchDockets = vi.fn().mockResolvedValue(baseDocketResult);
    const ctx = createMockContext();
    const input = searchDocketsTool.input.parse({ q: 'Apple Samsung patent' });
    const result = await searchDocketsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      docket_id: 8000,
      case_name: 'Apple Inc. v. Samsung Electronics',
      court_id: 'cand',
      jury_demand: 'Both',
    });
    expect(result.results[0].parties).toEqual(['Apple Inc.', 'Samsung Electronics']);
    expect(result.results[0].sample_documents).toHaveLength(1);
    expect(result.coverage_note).toBeTruthy();

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('passes optional filters to service', async () => {
    mockSvc.searchDockets = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchDocketsTool.input.parse({
      q: 'test',
      court: 'deb',
      party_name: 'Acme Corp',
    });
    await searchDocketsTool.handler(input, ctx);
    expect(mockSvc.searchDockets).toHaveBeenCalledWith(
      expect.objectContaining({ court: 'deb', party_name: 'Acme Corp' }),
      ctx,
    );
  });

  it('caps sample_documents at 3', async () => {
    const manyDocs = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      description: `Doc ${i + 1}`,
      date_filed: '2020-01-01',
      document_number: i + 1,
      is_available: true,
    }));
    mockSvc.searchDockets = vi.fn().mockResolvedValue({
      total: 1,
      results: [{ ...baseDocketResult.results[0], recap_documents: manyDocs }],
      nextCursor: null,
    });
    const ctx = createMockContext();
    const input = searchDocketsTool.input.parse({ q: 'test' });
    const result = await searchDocketsTool.handler(input, ctx);
    expect(result.results[0].sample_documents).toHaveLength(3);
  });

  it('enriches notice on empty results', async () => {
    mockSvc.searchDockets = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchDocketsTool.input.parse({ q: 'obscure case xyz', court: 'deb' });
    const result = await searchDocketsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('obscure case xyz');
  });

  it('throws when service throws', async () => {
    mockSvc.searchDockets = vi.fn().mockRejectedValue(new Error('rate limit'));
    const ctx = createMockContext();
    const input = searchDocketsTool.input.parse({ q: 'test' });
    await expect(searchDocketsTool.handler(input, ctx)).rejects.toThrow();
  });

  // #39 — a whitespace-only q previously reached CourtListener and returned
  // unrelated dockets while spending one of the 125 daily requests.
  describe('empty query (#39)', () => {
    it('trims q to empty and rejects without calling the service', async () => {
      mockSvc.searchDockets = vi.fn();
      const ctx = createMockContext({ errors: searchDocketsTool.errors });
      const input = searchDocketsTool.input.parse({ q: '   ' });
      expect(input.q).toBe('');

      const err = await searchDocketsTool.handler(input, ctx).catch((e) => e);
      expect(err).toMatchObject({ data: { reason: 'empty_query' } });
      expect(err.message).toContain('q');
      expect(mockSvc.searchDockets).not.toHaveBeenCalled();
    });

    it('trims incidental padding from an otherwise-valid q', async () => {
      mockSvc.searchDockets = vi.fn().mockResolvedValue(baseDocketResult);
      const ctx = createMockContext();
      const input = searchDocketsTool.input.parse({ q: '  Apple Inc  ' });
      await searchDocketsTool.handler(input, ctx);
      expect(mockSvc.searchDockets).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'Apple Inc' }),
        ctx,
      );
    });
  });

  // #40 — malformed dates reached the /search/ endpoint and returned an opaque 400.
  describe('invalid date filters (#40)', () => {
    for (const bad of ['banana', '2020-13-45', '2020-02-31']) {
      it(`rejects filed_after="${bad}" without calling the service`, async () => {
        mockSvc.searchDockets = vi.fn();
        const ctx = createMockContext({ errors: searchDocketsTool.errors });
        const input = searchDocketsTool.input.parse({ q: 'patent', filed_after: bad });

        const err = await searchDocketsTool.handler(input, ctx).catch((e) => e);
        expect(err).toMatchObject({ data: { reason: 'invalid_date' } });
        expect(err.message).toContain('filed_after');
        expect(err.message).toContain('YYYY-MM-DD');
        expect(mockSvc.searchDockets).not.toHaveBeenCalled();
      });
    }

    it('rejects a malformed filed_before without calling the service', async () => {
      mockSvc.searchDockets = vi.fn();
      const ctx = createMockContext({ errors: searchDocketsTool.errors });
      const input = searchDocketsTool.input.parse({ q: 'patent', filed_before: '2021-02-29' });

      const err = await searchDocketsTool.handler(input, ctx).catch((e) => e);
      expect(err).toMatchObject({ data: { reason: 'invalid_date' } });
      expect(err.message).toContain('filed_before');
      expect(mockSvc.searchDockets).not.toHaveBeenCalled();
    });

    it('lets valid calendar dates through to the service', async () => {
      mockSvc.searchDockets = vi.fn().mockResolvedValue(baseDocketResult);
      const ctx = createMockContext({ errors: searchDocketsTool.errors });
      const input = searchDocketsTool.input.parse({ q: 'patent', filed_after: '2020-02-29' });
      await searchDocketsTool.handler(input, ctx);
      expect(mockSvc.searchDockets).toHaveBeenCalledWith(
        expect.objectContaining({ filed_after: '2020-02-29' }),
        ctx,
      );
    });
  });

  it('formats output with all required fields', () => {
    const output = searchDocketsTool.output.parse({
      results: [
        {
          docket_id: 8000,
          case_name: 'Apple v. Samsung',
          court: 'N.D. Cal.',
          court_id: 'cand',
          date_filed: '2011-04-15',
          date_terminated: '2018-06-27',
          docket_number: '11-cv-01846',
          pacer_case_id: 'pacer123',
          assigned_to: 'Judge Koh',
          cause: 'Patent Infringement',
          jury_demand: 'Both',
          parties: ['Apple Inc.', 'Samsung'],
          document_count: 1500,
          sample_documents: [
            {
              id: 90000,
              description: 'Complaint',
              date_filed: '2011-04-15',
              document_number: 1,
              is_available: true,
            },
          ],
        },
      ],
      next_cursor: null,
      coverage_note: 'RECAP coverage is partial.',
    });
    const blocks = searchDocketsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('8000');
    expect(text).toContain('Apple v. Samsung');
    // jury_demand must be rendered
    expect(text).toContain('Both');
    // sample_documents[].id must be rendered
    expect(text).toContain('90000');
  });
});
