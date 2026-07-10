/**
 * @fileoverview Tests for the get-citations tool.
 * @module tests/tools/get-citations.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCitationsTool } from '@/mcp-server/tools/definitions/get-citations.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';

const mockSvc = {
  getCitedBy: vi.fn(),
  getCiting: vi.fn(),
  getClusterCaseName: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
  // cited_by resolves the source name via a lightweight cluster fetch.
  mockSvc.getClusterCaseName = vi.fn().mockResolvedValue('Landmark Case');
});

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
      snippet: 'relevant excerpt',
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
      snippet: '',
    },
  ],
  nextCursor: null,
};

describe('getCitationsTool', () => {
  it('fetches cited_by citations by default', async () => {
    mockSvc.getCitedBy = vi.fn().mockResolvedValue(mockCitingResult);
    const ctx = createMockContext();
    const input = getCitationsTool.input.parse({ cluster_id: 100 });
    const result = await getCitationsTool.handler(input, ctx);

    expect(result.source_cluster_id).toBe(100);
    expect(result.direction).toBe('cited_by');
    // cited_by resolves the source cluster's real case name via getClusterCaseName
    expect(result.source_case_name).toBe('Landmark Case');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].cluster_id).toBe(200);
    expect(result.results[0].case_name).toBe('Related Case One');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(2);
  });

  it('falls back to the cluster-id placeholder when source-name resolution fails', async () => {
    mockSvc.getCitedBy = vi.fn().mockResolvedValue(mockCitingResult);
    mockSvc.getClusterCaseName = vi.fn().mockRejectedValue(new Error('lookup failed'));
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = getCitationsTool.input.parse({ cluster_id: 100, direction: 'citing' });
    const result = await getCitationsTool.handler(input, ctx);

    expect(result.direction).toBe('citing');
    // citing gets the source name free from getCiting — no extra getClusterCaseName call
    expect(result.source_case_name).toBe('Source Opinion');
    expect(mockSvc.getClusterCaseName).not.toHaveBeenCalled();
    expect(mockSvc.getCiting).toHaveBeenCalledWith(
      expect.objectContaining({ clusterId: 100 }),
      ctx,
    );
    expect(mockSvc.getCitedBy).not.toHaveBeenCalled();
  });

  it('passes court and filed_after filters', async () => {
    mockSvc.getCitedBy = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
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

  it('passes the cursor through to getCiting and surfaces the advanced next_cursor (#24)', async () => {
    mockSvc.getCiting = vi.fn().mockResolvedValue({
      total: 5,
      results: [],
      nextCursor: '4',
      sourceCaseName: 'Source Opinion',
    });
    const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = getCitationsTool.input.parse({ cluster_id: 100 });
    await expect(getCitationsTool.handler(input, ctx)).rejects.toThrow();
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
});
