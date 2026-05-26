/**
 * @fileoverview Tests for the search-dockets tool.
 * @module tests/tools/search-dockets.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
  it('returns mapped docket summaries for valid input', async () => {
    mockSvc.searchDockets = vi.fn().mockResolvedValue(baseDocketResult);
    const ctx = createMockContext();
    const input = searchDocketsTool.input.parse({ q: 'Apple Samsung patent' });
    const result = await searchDocketsTool.handler(input, ctx);

    expect(result.total_count).toBe(1);
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

  it('throws when service throws', async () => {
    mockSvc.searchDockets = vi.fn().mockRejectedValue(new Error('rate limit'));
    const ctx = createMockContext();
    const input = searchDocketsTool.input.parse({ q: 'test' });
    await expect(searchDocketsTool.handler(input, ctx)).rejects.toThrow();
  });

  it('formats output with all required fields', () => {
    const output = searchDocketsTool.output.parse({
      total_count: 1,
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
