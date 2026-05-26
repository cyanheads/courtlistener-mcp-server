/**
 * @fileoverview Tests for the search-opinions tool.
 * @module tests/tools/search-opinions.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
      id: 100,
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
      id: 101,
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
  it('returns mapped opinion summaries for valid input', async () => {
    mockSvc.searchOpinions = vi.fn().mockResolvedValue(baseResult);
    const ctx = createMockContext();
    const input = searchOpinionsTool.input.parse({ q: 'abortion rights' });
    const result = await searchOpinionsTool.handler(input, ctx);

    expect(result.total_count).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      cluster_id: 100,
      case_name: 'Roe v. Wade',
      case_name_full: 'Roe v. Wade (Full)',
      court: 'Supreme Court',
      court_id: 'scotus',
    });
    expect(result.next_cursor).toBeNull();
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

  it('returns empty results with next_cursor when no matches', async () => {
    mockSvc.searchOpinions = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchOpinionsTool.input.parse({ q: 'no match query xyz123' });
    const result = await searchOpinionsTool.handler(input, ctx);
    expect(result.total_count).toBe(0);
    expect(result.results).toHaveLength(0);
  });

  it('throws when service throws', async () => {
    mockSvc.searchOpinions = vi.fn().mockRejectedValue(new Error('rate limit'));
    const ctx = createMockContext();
    const input = searchOpinionsTool.input.parse({ q: 'test' });
    await expect(searchOpinionsTool.handler(input, ctx)).rejects.toThrow();
  });

  it('formats output with required fields', () => {
    const output = searchOpinionsTool.output.parse({
      total_count: 1,
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
      total_count: 0,
      results: [],
      next_cursor: null,
    });
    const blocks = searchOpinionsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No opinions matched');
  });

  it('format handles sparse upstream payload — missing optional fields', () => {
    const output = searchOpinionsTool.output.parse({
      total_count: 1,
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
