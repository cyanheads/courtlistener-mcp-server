/**
 * @fileoverview Tests for the search-judges tool.
 * @module tests/tools/search-judges.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchJudgesTool } from '@/mcp-server/tools/definitions/search-judges.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';

const mockSvc = {
  searchJudges: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

const basePersonResult = {
  total: 1,
  results: [
    {
      id: 300,
      name: 'Ruth Bader Ginsburg',
      gender: 'F',
      dob: '1933-03-15',
      dob_city: 'Brooklyn',
      dob_state: 'NY',
      political_affiliation: ['d'],
      aba_rating: ['Highly Qualified'],
      school: ['Cornell University', 'Columbia Law School'],
      court: 'Supreme Court of the United States',
      court_id: 'scotus',
      position_type: 'Associate Justice',
      appointer: 'Clinton',
      date_start: '1993-08-10',
    },
  ],
  nextCursor: null,
};

describe('searchJudgesTool', () => {
  it('returns mapped judge records for valid input', async () => {
    mockSvc.searchJudges = vi.fn().mockResolvedValue(basePersonResult);
    const ctx = createMockContext();
    const input = searchJudgesTool.input.parse({ q: 'Ginsburg' });
    const result = await searchJudgesTool.handler(input, ctx);

    expect(result.total_count).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      person_id: 300,
      name: 'Ruth Bader Ginsburg',
      gender: 'F',
    });
    expect(result.results[0].current_position).toMatchObject({
      court: 'Supreme Court of the United States',
      court_id: 'scotus',
      position_type: 'Associate Justice',
      appointer: 'Clinton',
    });
  });

  it('passes optional filters to service', async () => {
    mockSvc.searchJudges = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchJudgesTool.input.parse({
      q: 'judge',
      appointer: 'Obama',
      political_affiliation: 'd',
    });
    await searchJudgesTool.handler(input, ctx);
    expect(mockSvc.searchJudges).toHaveBeenCalledWith(
      expect.objectContaining({ appointer: 'Obama', political_affiliation: 'd' }),
      ctx,
    );
  });

  it('sets current_position to null when no court or position_type present', async () => {
    mockSvc.searchJudges = vi.fn().mockResolvedValue({
      total: 1,
      results: [
        {
          id: 301,
          name: 'Unknown Judge',
          gender: 'U',
          dob: null,
          dob_city: null,
          dob_state: null,
          political_affiliation: [],
          aba_rating: [],
          school: [],
          court: null,
          court_id: null,
          position_type: null,
          appointer: null,
          date_start: null,
        },
      ],
      nextCursor: null,
    });
    const ctx = createMockContext();
    const input = searchJudgesTool.input.parse({ q: 'unknown' });
    const result = await searchJudgesTool.handler(input, ctx);
    expect(result.results[0].current_position).toBeNull();
  });

  it('throws when service throws', async () => {
    mockSvc.searchJudges = vi.fn().mockRejectedValue(new Error('service error'));
    const ctx = createMockContext();
    const input = searchJudgesTool.input.parse({ q: 'test' });
    await expect(searchJudgesTool.handler(input, ctx)).rejects.toThrow();
  });

  it('formats output including current_position.court_id', () => {
    const output = searchJudgesTool.output.parse({
      total_count: 1,
      results: [
        {
          person_id: 300,
          name: 'RBG',
          gender: 'F',
          dob: '1933-03-15',
          dob_city: 'Brooklyn',
          dob_state: 'NY',
          political_affiliation: ['d'],
          aba_rating: ['WQ'],
          schools: ['Cornell'],
          current_position: {
            court: 'Supreme Court',
            court_id: 'scotus',
            position_type: 'Justice',
            appointer: 'Clinton',
            date_start: '1993-08-10',
          },
        },
      ],
      next_cursor: null,
    });
    const blocks = searchJudgesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('300');
    expect(text).toContain('RBG');
    // court_id must be rendered for parity
    expect(text).toContain('scotus');
  });
});
