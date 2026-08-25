/**
 * @fileoverview Tests for the get-judge tool.
 * @module tests/tools/get-judge.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getJudgeTool } from '@/mcp-server/tools/definitions/get-judge.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';
import type { Person, PersonPosition } from '@/services/courtlistener/types.js';

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
  date_granularity_dob: '%Y-%m-%d',
  dob_city: 'Brooklyn',
  dob_state: 'NY',
  date_dod: null,
  date_granularity_dod: '',
  fjc_id: 456,
  aba_ratings: [{ rating: 'wq', year_rated: 1993 }],
  political_affiliations: [{ political_party: 'd', date_start: '1993-01-01', date_end: null }],
  educations: [
    {
      school: { name: 'Cornell University' },
      degree_level: 'BA',
      degree_year: 1954,
    },
    {
      school: { name: 'Columbia Law School' },
      degree_level: 'JD',
      degree_year: 1959,
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
      job_title: '',
      organization_name: null,
      appointer: 'https://www.courtlistener.com/api/rest/v4/positions/44/',
      how_selected: 'a_pres',
      nomination_process: null,
      date_nominated: '1993-06-22',
      date_confirmation: '1993-08-03',
      date_start: '1993-08-10',
      date_granularity_start: '%Y-%m-%d',
      date_termination: '2020-09-18',
      date_granularity_termination: '%Y-%m-%d',
      termination_reason: 'ded',
    },
  ],
};

describe('getJudgeTool', () => {
  it('returns full judge profile for valid person_id', async () => {
    mockSvc.getPerson = vi.fn().mockResolvedValue(basePerson);
    const ctx = createMockContext({ errors: getJudgeTool.errors });
    const input = getJudgeTool.input.parse({ person_id: 300 });
    const result = await getJudgeTool.handler(input, ctx);

    expect(result.person_id).toBe(300);
    // name_full is null — falls back to name_first + name_last
    expect(result.name).toBe('Ruth Bader Ginsburg');
    // single-letter codes are expanded to readable labels (matching search_judges output)
    expect(result.gender).toBe('Female');
    expect(result.aba_ratings).toContain('Well Qualified');
    expect(result.political_affiliations[0]!.affiliation).toBe('Democratic');
    expect(result.education).toHaveLength(2);
    expect(result.education[0]!.school).toBe('Cornell University');
    // the year comes from upstream's degree_year column; reading a key CourtListener
    // does not serve left this null for every record ever returned
    expect(result.education[0]!.year).toBe(1954);
    expect(result.education[1]!.year).toBe(1959);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]).toMatchObject({
      court: 'Supreme Court of the United States',
      court_id: 'scotus',
      // how_selected code (a_pres) expands to a readable selection-method label
      nomination_process: 'Appointment (President)',
      // appointer is surfaced as the raw position URI (not resolved to a name)
      appointer: 'https://www.courtlistener.com/api/rest/v4/positions/44/',
      date_nominated: '1993-06-22',
      date_confirmation: '1993-08-03',
    });
  });

  it('expands known how_selected codes and passes unknown codes through', async () => {
    const mkPosition = (how_selected: string): PersonPosition => ({
      court: {
        id: 'scotus',
        full_name: 'Supreme Court of the United States',
        short_name: 'Supreme Court',
      },
      position_type: 'jud',
      job_title: '',
      organization_name: null,
      appointer: null,
      how_selected,
      nomination_process: null,
      date_nominated: null,
      date_confirmation: null,
      date_start: null,
      date_granularity_start: '',
      date_termination: null,
      date_granularity_termination: '',
      termination_reason: null,
    });
    const person: Person = {
      ...basePerson,
      positions: [mkPosition('e_part'), mkPosition('x_unknown_code')],
    };
    mockSvc.getPerson = vi.fn().mockResolvedValue(person);
    const ctx = createMockContext({ errors: getJudgeTool.errors });
    const input = getJudgeTool.input.parse({ person_id: 300 });
    const result = await getJudgeTool.handler(input, ctx);
    // known code expands
    expect(result.positions[0]!.nomination_process).toBe('Partisan Election');
    // unknown code passes through unchanged rather than being dropped or guessed
    expect(result.positions[1]!.nomination_process).toBe('x_unknown_code');
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
      date_granularity_dob: null,
      dob_city: null,
      dob_state: null,
      date_dod: null,
      date_granularity_dod: null,
      fjc_id: null,
      aba_ratings: [],
      political_affiliations: [],
      educations: [],
      positions: [],
    };
    mockSvc.getPerson = vi.fn().mockResolvedValue(sparsePerson);
    const ctx = createMockContext({ errors: getJudgeTool.errors });
    const input = getJudgeTool.input.parse({ person_id: 301 });
    const result = await getJudgeTool.handler(input, ctx);
    expect(result.aba_ratings).toEqual([]);
    expect(result.positions).toEqual([]);
    expect(result.education).toEqual([]);
    // unknown codes pass through unchanged rather than being dropped or guessed
    expect(result.gender).toBe('U');
  });

  it('formats output with nomination_process, date_nominated, and date_confirmation', () => {
    const output = getJudgeTool.output.parse({
      person_id: 300,
      name: 'Ruth Bader Ginsburg',
      gender: 'F',
      dob: '1933-03-15',
      dob_granularity: 'day',
      dob_city: 'Brooklyn',
      dob_state: 'NY',
      dod: null,
      dod_granularity: null,
      fjc_id: 456,
      aba_ratings: ['wq'],
      political_affiliations: [{ affiliation: 'd', date_start: '1993-01-01', date_end: null }],
      education: [
        {
          school: 'Cornell University',
          degree: 'ba',
          degree_label: "Bachelor's (e.g. B.A.)",
          year: 1954,
        },
      ],
      positions: [
        {
          court: 'Supreme Court',
          court_id: 'scotus',
          position_type: 'ass-jus',
          position_type_label: 'Associate Justice',
          job_title: '',
          organization_name: '',
          appointer: 'https://www.courtlistener.com/api/rest/v4/positions/44/',
          nomination_process: 'Appointment (President)',
          date_nominated: '1993-06-22',
          date_confirmation: '1993-08-03',
          date_start: '1993-08-10',
          date_start_granularity: 'day',
          date_termination: '2020-09-18',
          date_termination_granularity: 'day',
          termination_reason: 'ded',
          termination_reason_label: 'Death',
        },
      ],
    });
    const blocks = getJudgeTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('300');
    expect(text).toContain('Ruth Bader Ginsburg');
    // nomination_process must be rendered
    expect(text).toContain('Appointment (President)');
    // date_nominated must be rendered
    expect(text).toContain('1993-06-22');
    // date_confirmation must be rendered
    expect(text).toContain('1993-08-03');
  });

  it('reports every unrecorded blank-able field as null, not an empty string', async () => {
    // degree_level, termination_reason, dob_city, and dob_state are all CharFields
    // upstream with blank=True and no null=True, so "not recorded" arrives as "".
    // Every one of these output fields documents null — and the _label twins already
    // return null — so the raw fields have to say null too.
    const person: Person = {
      ...basePerson,
      dob_city: '',
      dob_state: '',
      educations: [{ school: { name: 'Somewhere' }, degree_level: '', degree_year: null }],
      positions: [{ ...basePerson.positions[0]!, termination_reason: '' }],
    };
    mockSvc.getPerson = vi.fn().mockResolvedValue(person);
    const ctx = createMockContext({ errors: getJudgeTool.errors });
    const input = getJudgeTool.input.parse({ person_id: 300 });
    const result = await getJudgeTool.handler(input, ctx);

    expect(result).toMatchObject({ dob_city: null, dob_state: null });
    expect(result.education[0]).toMatchObject({ degree: null, degree_label: null });
    expect(result.positions[0]).toMatchObject({
      termination_reason: null,
      termination_reason_label: null,
    });
  });

  // #46 — /people/ and /positions/ serve stored codes where the person search endpoint
  // serves labels, so the same record read two ways disagreed on what it said.
  describe('position, termination, and degree code expansion (#46)', () => {
    it('expands the codes and keeps the raw values beside them', async () => {
      mockSvc.getPerson = vi.fn().mockResolvedValue(basePerson);
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      const result = await getJudgeTool.handler(input, ctx);

      expect(result.positions[0]).toMatchObject({
        position_type: 'jud',
        position_type_label: 'Judge',
        termination_reason: 'ded',
        termination_reason_label: 'Death',
      });
      expect(result.education[0]).toMatchObject({
        degree: 'BA',
        degree_label: "Bachelor's (e.g. B.A.)",
      });
      expect(result.education[1]).toMatchObject({
        degree: 'JD',
        degree_label: 'Juris Doctor (J.D.)',
      });

      const text = (getJudgeTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Judge** [jud] at Supreme Court of the United States (scotus)');
      expect(text).toContain('Ended: Death [ded]');
      expect(text).toContain("Cornell University, Bachelor's (e.g. B.A.) [BA] (1954)");
    });

    it('covers the non-judicial half of POSITION_TYPES, not only the judicial group', async () => {
      const person: Person = {
        ...basePerson,
        positions: [
          {
            court: null,
            position_type: 'ada',
            job_title: '',
            organization_name: null,
            appointer: null,
            how_selected: null,
            nomination_process: null,
            date_nominated: null,
            date_confirmation: null,
            date_start: '1979-01-01',
            date_granularity_start: '%Y-%m-%d',
            date_termination: null,
            date_granularity_termination: '',
            termination_reason: null,
          },
        ],
      };
      mockSvc.getPerson = vi.fn().mockResolvedValue(person);
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      const result = await getJudgeTool.handler(input, ctx);
      expect(result.positions[0]?.position_type_label).toBe('Assistant District Attorney');
    });

    it('passes unknown codes through rather than dropping or guessing them', async () => {
      const person: Person = {
        ...basePerson,
        educations: [{ school: { name: 'Somewhere' }, degree_level: 'xyz', degree_year: null }],
        positions: [
          {
            court: null,
            position_type: 'new-code',
            job_title: '',
            organization_name: null,
            appointer: null,
            how_selected: null,
            nomination_process: null,
            date_nominated: null,
            date_confirmation: null,
            date_start: null,
            date_granularity_start: '',
            date_termination: '2020-01-01',
            date_granularity_termination: '%Y-%m-%d',
            termination_reason: 'new_reason',
          },
        ],
      };
      mockSvc.getPerson = vi.fn().mockResolvedValue(person);
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      const result = await getJudgeTool.handler(input, ctx);

      expect(result.positions[0]?.position_type_label).toBe('new-code');
      expect(result.positions[0]?.termination_reason_label).toBe('new_reason');
      expect(result.education[0]?.degree_label).toBe('xyz');
      // an unmapped code is the label, so it is not repeated in brackets
      const text = (getJudgeTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**new-code**');
      expect(text).not.toContain('[new-code]');
    });

    it('surfaces job_title and organization_name for a row with no position_type', async () => {
      const person: Person = {
        ...basePerson,
        positions: [
          {
            court: null,
            position_type: null,
            job_title: 'Private practice',
            organization_name: 'New York City',
            appointer: null,
            how_selected: null,
            nomination_process: null,
            date_nominated: null,
            date_confirmation: null,
            date_start: '1984-01-01',
            date_granularity_start: '%Y',
            date_termination: '1992-01-01',
            date_granularity_termination: '%Y',
            termination_reason: null,
          },
        ],
      };
      mockSvc.getPerson = vi.fn().mockResolvedValue(person);
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      const result = await getJudgeTool.handler(input, ctx);

      expect(result.positions[0]).toMatchObject({
        position_type: '',
        position_type_label: '',
        job_title: 'Private practice',
        organization_name: 'New York City',
      });
      // without these two fields the row rendered as "**** at  ()" — every surfaced field empty
      const text = (getJudgeTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Private practice** at New York City');
      expect(text).not.toContain('****');
    });
  });

  // #47 — CourtListener stores a year-only date as YYYY-01-01, so passing the stored
  // value through claimed a month and day the record does not have.
  describe('date granularity (#47)', () => {
    const withDob = (date_dob: string, date_granularity_dob: string): Person => ({
      ...basePerson,
      date_dob,
      date_granularity_dob,
    });

    it('renders a year-only birth date as the year, keeping the stored ISO date', async () => {
      mockSvc.getPerson = vi.fn().mockResolvedValue(withDob('1954-01-01', '%Y'));
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      const result = await getJudgeTool.handler(input, ctx);

      expect(result.dob).toBe('1954-01-01');
      expect(result.dob_granularity).toBe('year');
      const text = (getJudgeTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Born:** 1954, Brooklyn, NY');
      expect(text).not.toContain('1954-01-01');
    });

    it('renders a month-only birth date to the month', async () => {
      mockSvc.getPerson = vi.fn().mockResolvedValue(withDob('1954-06-01', '%Y-%m'));
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      const result = await getJudgeTool.handler(input, ctx);

      expect(result.dob_granularity).toBe('month');
      const text = (getJudgeTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Born:** 1954-06,');
      expect(text).not.toContain('1954-06-01');
    });

    it('renders a day-precision date in full', async () => {
      mockSvc.getPerson = vi.fn().mockResolvedValue(basePerson);
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      const result = await getJudgeTool.handler(input, ctx);

      expect(result.dob_granularity).toBe('day');
      const text = (getJudgeTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Born:** 1933-03-15, Brooklyn, NY');
    });

    it('reports no granularity when the record carries none, and renders the stored date', async () => {
      mockSvc.getPerson = vi.fn().mockResolvedValue(withDob('1954-01-01', ''));
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      const result = await getJudgeTool.handler(input, ctx);

      expect(result.dob_granularity).toBeNull();
      const text = (getJudgeTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Born:** 1954-01-01');
    });

    it('renders a position term to the precision each end was recorded at', async () => {
      const person: Person = {
        ...basePerson,
        positions: [
          {
            court: {
              id: 'ca2',
              full_name: 'Court of Appeals for the Second Circuit',
              short_name: 'Second Circuit',
            },
            position_type: 'jud',
            job_title: '',
            organization_name: null,
            appointer: null,
            how_selected: null,
            nomination_process: null,
            date_nominated: null,
            date_confirmation: null,
            date_start: '1801-01-01',
            date_granularity_start: '%Y',
            date_termination: '1835-06-01',
            date_granularity_termination: '%Y-%m',
            termination_reason: null,
          },
        ],
      };
      mockSvc.getPerson = vi.fn().mockResolvedValue(person);
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      const result = await getJudgeTool.handler(input, ctx);

      // the stored ISO dates survive; the granularity says how much of them is real
      expect(result.positions[0]).toMatchObject({
        date_start: '1801-01-01',
        date_start_granularity: 'year',
        date_termination: '1835-06-01',
        date_termination_granularity: 'month',
      });
      const text = (getJudgeTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('Term: 1801 – 1835-06');
      expect(text).not.toContain('1801-01-01');
      expect(text).not.toContain('1835-06-01');
    });

    it('renders an unterminated position to its start precision, still as "present"', async () => {
      const person: Person = {
        ...basePerson,
        positions: [
          {
            ...basePerson.positions[0]!,
            date_start: '1998-01-01',
            date_granularity_start: '%Y',
            date_termination: null,
            date_granularity_termination: '',
            termination_reason: null,
          },
        ],
      };
      mockSvc.getPerson = vi.fn().mockResolvedValue(person);
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      const result = await getJudgeTool.handler(input, ctx);

      expect(result.positions[0]?.date_termination_granularity).toBeNull();
      const text = (getJudgeTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('Term: 1998 – present');
    });

    it('renders day-precision position dates in full', async () => {
      mockSvc.getPerson = vi.fn().mockResolvedValue(basePerson);
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      const result = await getJudgeTool.handler(input, ctx);
      const text = (getJudgeTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('Term: 1993-08-10 – 2020-09-18');
    });

    it('carries death-date granularity the same way', async () => {
      mockSvc.getPerson = vi.fn().mockResolvedValue({
        ...basePerson,
        date_dod: '2020-01-01',
        date_granularity_dod: '%Y',
      });
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      const result = await getJudgeTool.handler(input, ctx);

      expect(result.dod).toBe('2020-01-01');
      expect(result.dod_granularity).toBe('year');
      const text = (getJudgeTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Died:** 2020');
    });
  });
  // #64 — /positions/ is cursor-paginated and the fetch took only the first page, so a
  // long career came back short with nothing in the response saying so. A truncated list
  // is byte-identical to a complete one; only a caller-visible flag separates them.
  describe('position truncation disclosure (#64)', () => {
    it('reports the walk reaching the end, on a surface the caller can read', async () => {
      mockSvc.getPerson = vi.fn().mockResolvedValue({ ...basePerson, positions_truncated: false });
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      await getJudgeTool.handler(input, ctx);

      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(false);
      expect(enrichment.positionsShown).toBe(1);
      expect(enrichment.notice).toBeUndefined();
    });

    it('reports a bounded-out position history to the caller, not just the log', async () => {
      mockSvc.getPerson = vi.fn().mockResolvedValue({ ...basePerson, positions_truncated: true });
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      const result = await getJudgeTool.handler(input, ctx);

      // structuredContent and the content[] trailer both carry enrichment, so this is
      // the caller's answer — a ctx.log.warning would never leave the server.
      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.positionsShown).toBe(1);
      expect(enrichment.notice).toContain('partial');
      // The domain payload is unchanged and still valid — disclosure rides alongside it.
      expect(result.positions).toHaveLength(1);
    });

    it('treats a payload with no truncation flag as complete', async () => {
      mockSvc.getPerson = vi.fn().mockResolvedValue(basePerson);
      const ctx = createMockContext({ errors: getJudgeTool.errors });
      const input = getJudgeTool.input.parse({ person_id: 300 });
      await getJudgeTool.handler(input, ctx);

      expect(getEnrichment(ctx).truncated).toBe(false);
    });
  });
});
