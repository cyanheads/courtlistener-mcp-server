/**
 * @fileoverview Tests for the get-judge tool.
 * @module tests/tools/get-judge.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getJudgeTool } from '@/mcp-server/tools/definitions/get-judge.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';
import type { Person } from '@/services/courtlistener/types.js';

const mockSvc = {
  getPerson: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

const basePerson: Person = {
  id: 300,
  name_full: null,
  name_first: 'Ruth Bader',
  name_last: 'Ginsburg',
  gender: 'F',
  date_dob: '1933-03-15',
  dob_city: 'Brooklyn',
  dob_state: 'NY',
  date_dod: null,
  fjc_id: 456,
  aba_ratings: [{ rating: 'wq', year_rated: 1993 }],
  political_affiliations: [{ political_party: 'd', date_start: '1993-01-01', date_end: null }],
  educations: [
    {
      school: { name: 'Cornell University' },
      degree_level: 'BA',
      graduation_year: 1954,
    },
    {
      school: { name: 'Columbia Law School' },
      degree_level: 'JD',
      graduation_year: 1959,
    },
  ],
  positions: [
    {
      court: {
        id: 'scotus',
        full_name: 'Supreme Court of the United States',
        short_name: 'Supreme Court',
      },
      position_type: 'jud',
      appointer: 'https://www.courtlistener.com/api/rest/v4/positions/44/',
      how_selected: 'Senate confirmation',
      nomination_process: null,
      date_nominated: '1993-06-22',
      date_confirmation: '1993-08-03',
      date_start: '1993-08-10',
      date_termination: '2020-09-18',
      termination_reason: 'Death',
    },
  ],
};

describe('getJudgeTool', () => {
  it('returns full judge profile for valid person_id', async () => {
    mockSvc.getPerson = vi.fn().mockResolvedValue(basePerson);
    const ctx = createMockContext();
    const input = getJudgeTool.input.parse({ person_id: 300 });
    const result = await getJudgeTool.handler(input, ctx);

    expect(result.person_id).toBe(300);
    // name_full is null — falls back to name_first + name_last
    expect(result.name).toBe('Ruth Bader Ginsburg');
    // aba_ratings are rating codes
    expect(result.aba_ratings).toContain('wq');
    expect(result.education).toHaveLength(2);
    expect(result.education[0].school).toBe('Cornell University');
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]).toMatchObject({
      court: 'Supreme Court of the United States',
      court_id: 'scotus',
      // how_selected maps to nomination_process
      nomination_process: 'Senate confirmation',
      date_nominated: '1993-06-22',
      date_confirmation: '1993-08-03',
    });
  });

  it('throws not_found for missing person', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockSvc.getPerson = vi
      .fn()
      .mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'not found'));
    const ctx = createMockContext({ errors: getJudgeTool.errors });
    const input = getJudgeTool.input.parse({ person_id: 99999 });
    await expect(getJudgeTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('handles sparse upstream payload — missing optional fields', async () => {
    const sparsePerson: Person = {
      id: 301,
      name_full: null,
      name_first: 'Anonymous',
      name_last: 'Judge',
      gender: 'U',
      date_dob: null,
      dob_city: null,
      dob_state: null,
      date_dod: null,
      fjc_id: null,
      aba_ratings: [],
      political_affiliations: [],
      educations: [],
      positions: [],
    };
    mockSvc.getPerson = vi.fn().mockResolvedValue(sparsePerson);
    const ctx = createMockContext();
    const input = getJudgeTool.input.parse({ person_id: 301 });
    const result = await getJudgeTool.handler(input, ctx);
    expect(result.aba_ratings).toEqual([]);
    expect(result.positions).toEqual([]);
    expect(result.education).toEqual([]);
  });

  it('formats output with nomination_process, date_nominated, and date_confirmation', () => {
    const output = getJudgeTool.output.parse({
      person_id: 300,
      name: 'Ruth Bader Ginsburg',
      gender: 'F',
      dob: '1933-03-15',
      dob_city: 'Brooklyn',
      dob_state: 'NY',
      dod: null,
      fjc_id: 456,
      aba_ratings: ['wq'],
      political_affiliations: [{ affiliation: 'd', date_start: '1993-01-01', date_end: null }],
      education: [{ school: 'Cornell University', degree: 'BA', year: 1954 }],
      positions: [
        {
          court: 'Supreme Court',
          court_id: 'scotus',
          position_type: 'Associate Justice',
          appointer: 'Clinton',
          nomination_process: 'Senate confirmation',
          date_nominated: '1993-06-22',
          date_confirmation: '1993-08-03',
          date_start: '1993-08-10',
          date_termination: '2020-09-18',
          termination_reason: 'Death',
        },
      ],
    });
    const blocks = getJudgeTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('300');
    expect(text).toContain('Ruth Bader Ginsburg');
    // nomination_process must be rendered
    expect(text).toContain('Senate confirmation');
    // date_nominated must be rendered
    expect(text).toContain('1993-06-22');
    // date_confirmation must be rendered
    expect(text).toContain('1993-08-03');
  });
});
