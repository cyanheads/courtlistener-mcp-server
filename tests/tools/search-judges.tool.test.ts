/**
 * @fileoverview Tests for the search-judges tool.
 * @module tests/tools/search-judges.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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

/** A `positions[]` row shaped like a captured `/search/?type=p` v4 response. */
function position(overrides: Record<string, unknown> = {}) {
  return {
    appointer: null,
    court_exact: null,
    court_full_name: null,
    date_start: null,
    date_termination: null,
    // Upstream sends '' rather than null for these text columns.
    job_title: '',
    organization_name: null,
    position_type: null,
    selection_method: '',
    termination_reason: '',
    ...overrides,
  };
}

/**
 * Keys mirror a captured `/search/?type=p` v4 response: court, position type,
 * appointer, and dates live only inside `positions[]`, never flat on the person
 * row. Fixtures with flat fields kept the suite green while current_position was
 * null on every real call. `political_affiliation`/`aba_rating` carry expanded
 * labels — the codes are on the separate `*_id` keys.
 */
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
      political_affiliation: ['Democratic'],
      political_affiliation_id: ['d'],
      aba_rating: ['Well Qualified'],
      school: ['Cornell University', 'Columbia Law School'],
      positions: [
        position({
          court_full_name: 'Supreme Court of the United States',
          court_exact: 'scotus',
          position_type: 'Associate Justice',
          appointer: 'Clinton, William Jefferson',
          selection_method: 'Appointment (President)',
          date_start: '1993-08-10',
        }),
      ],
    },
  ],
  nextCursor: null,
};

describe('searchJudgesTool', () => {
  it('returns mapped judge records and enriches total for valid input', async () => {
    mockSvc.searchJudges = vi.fn().mockResolvedValue(basePersonResult);
    const ctx = createMockContext();
    const input = searchJudgesTool.input.parse({ q: 'Ginsburg' });
    const result = await searchJudgesTool.handler(input, ctx);

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
      appointer: 'Clinton, William Jefferson',
      selection_method: 'Appointment (President)',
      date_start: '1993-08-10',
      date_termination: null,
    });

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.notice).toBeUndefined();
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

  it('sets current_position to null when the record carries no positions', async () => {
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
          positions: [],
        },
      ],
      nextCursor: null,
    });
    const ctx = createMockContext();
    const input = searchJudgesTool.input.parse({ q: 'unknown' });
    const result = await searchJudgesTool.handler(input, ctx);
    expect(result.results[0].current_position).toBeNull();
  });

  // #44 — current_position read court/position_type/appointer/date_start off the
  // top level of the person row, where v4 has no such keys, so the guard never
  // fired and every judge came back with current_position: null.
  describe('positions[] selection rule (#44)', () => {
    // Ordered as upstream returns them — not chronological, and the current
    // position is not first.
    const sotomayorPositions = [
      position({
        court_full_name: 'Court of Appeals for the Second Circuit',
        court_exact: 'ca2',
        position_type: 'Judge',
        appointer: 'Clinton, William Jefferson',
        selection_method: 'Appointment (President)',
        date_start: '1998-10-07',
        date_termination: '2009-08-07',
        termination_reason: 'Appointed to Other Judgeship',
      }),
      position({
        court_full_name: 'Supreme Court of the United States',
        court_exact: 'scotus',
        position_type: 'Judge',
        appointer: 'Obama, Barack Hussein, II',
        selection_method: 'Appointment (President)',
        date_start: '2009-08-06',
        date_termination: null,
      }),
      position({
        job_title: 'Assistant district attorney',
        organization_name: 'New York County',
        date_start: '1979-01-01',
        date_termination: '1984-01-01',
      }),
    ];

    async function runWith(positions: unknown[]) {
      mockSvc.searchJudges = vi.fn().mockResolvedValue({
        total: 1,
        results: [
          {
            id: 3045,
            name: 'Sonia Sotomayor',
            gender: 'Female',
            dob: '1954-01-01',
            dob_city: 'Bronx',
            dob_state: 'New York',
            political_affiliation: ['Republican', 'Democratic', 'Democratic'],
            aba_rating: ['Qualified', 'Well Qualified'],
            school: ['Princeton University', 'Yale University'],
            positions,
          },
        ],
        nextCursor: null,
      });
      const ctx = createMockContext();
      const input = searchJudgesTool.input.parse({ q: 'Sotomayor' });
      return searchJudgesTool.handler(input, ctx);
    }

    it('picks the un-terminated position from a multi-position history', async () => {
      const result = await runWith(sotomayorPositions);

      expect(result.results[0].current_position).toEqual({
        court: 'Supreme Court of the United States',
        court_id: 'scotus',
        position_type: 'Judge',
        job_title: null,
        organization_name: null,
        appointer: 'Obama, Barack Hussein, II',
        selection_method: 'Appointment (President)',
        date_start: '2009-08-06',
        date_termination: null,
        termination_reason: null,
      });
    });

    it('falls back to the latest date_start when every position is terminated', async () => {
      const result = await runWith(sotomayorPositions.filter((p) => p.date_termination));

      expect(result.results[0].current_position).toMatchObject({
        court_id: 'ca2',
        date_start: '1998-10-07',
        date_termination: '2009-08-07',
        termination_reason: 'Appointed to Other Judgeship',
      });
    });

    it('breaks a multiple-un-terminated tie by the latest date_start', async () => {
      const result = await runWith([
        position({ court_exact: 'nysd', position_type: 'Judge', date_start: '1992-08-12' }),
        position({ court_exact: 'ca2', position_type: 'Judge', date_start: '1998-10-07' }),
      ]);

      expect(result.results[0].current_position).toMatchObject({ court_id: 'ca2' });
    });

    it('carries a non-judicial position through job_title and organization_name', async () => {
      const result = await runWith([sotomayorPositions[2]]);

      expect(result.results[0].current_position).toMatchObject({
        court: null,
        court_id: null,
        position_type: null,
        job_title: 'Assistant district attorney',
        organization_name: 'New York County',
      });
    });

    it('surfaces expanded affiliation and ABA labels, not codes', async () => {
      const result = await runWith(sotomayorPositions);

      expect(result.results[0].political_affiliation).toEqual([
        'Republican',
        'Democratic',
        'Democratic',
      ]);
      expect(result.results[0].aba_rating).toEqual(['Qualified', 'Well Qualified']);
      expect(
        searchJudgesTool.output.shape.results.element.shape.political_affiliation.description,
      ).toMatch(/label/i);
    });
  });

  it('enriches notice on empty results', async () => {
    mockSvc.searchJudges = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchJudgesTool.input.parse({ q: 'xyz notajudge', appointer: 'Nonexistent' });
    const result = await searchJudgesTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('xyz notajudge');
  });

  it('throws when service throws', async () => {
    mockSvc.searchJudges = vi.fn().mockRejectedValue(new Error('service error'));
    const ctx = createMockContext();
    const input = searchJudgesTool.input.parse({ q: 'test' });
    await expect(searchJudgesTool.handler(input, ctx)).rejects.toThrow();
  });

  // #39 — a whitespace-only q previously reached CourtListener and spent one of
  // the 125 daily requests on unrelated judge records.
  describe('empty query (#39)', () => {
    it('trims q to empty and rejects without calling the service', async () => {
      mockSvc.searchJudges = vi.fn();
      const ctx = createMockContext({ errors: searchJudgesTool.errors });
      const input = searchJudgesTool.input.parse({ q: '   ' });
      expect(input.q).toBe('');

      const err = await searchJudgesTool.handler(input, ctx).catch((e) => e);
      expect(err).toMatchObject({ data: { reason: 'empty_query' } });
      expect(err.message).toContain('q');
      expect(mockSvc.searchJudges).not.toHaveBeenCalled();
    });

    it('trims incidental padding from an otherwise-valid q', async () => {
      mockSvc.searchJudges = vi.fn().mockResolvedValue(basePersonResult);
      const ctx = createMockContext();
      const input = searchJudgesTool.input.parse({ q: '  Sotomayor  ' });
      await searchJudgesTool.handler(input, ctx);
      expect(mockSvc.searchJudges).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'Sotomayor' }),
        ctx,
      );
    });
  });

  it('formats output including current_position.court_id', () => {
    const output = searchJudgesTool.output.parse({
      results: [
        {
          person_id: 300,
          name: 'RBG',
          gender: 'F',
          dob: '1933-03-15',
          dob_city: 'Brooklyn',
          dob_state: 'NY',
          political_affiliation: ['Democratic'],
          aba_rating: ['Well Qualified'],
          schools: ['Cornell'],
          current_position: {
            court: 'Supreme Court',
            court_id: 'scotus',
            position_type: 'Justice',
            job_title: null,
            organization_name: null,
            appointer: 'Clinton',
            selection_method: 'Appointment (President)',
            date_start: '1993-08-10',
            date_termination: '2020-09-18',
            termination_reason: 'Death',
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
    // #44 — the position fields added with the nested-positions fix
    expect(text).toContain('Appointment (President)');
    expect(text).toContain('2020-09-18');
    expect(text).toContain('Death');
  });
});
