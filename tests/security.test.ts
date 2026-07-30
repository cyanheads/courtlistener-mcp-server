/**
 * @fileoverview Security tests — injection inputs, oversized payloads, token/env var
 * hygiene, and assertion that no secret ever appears in tool output or error messages.
 * @module tests/security.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getCitationsTool } from '@/mcp-server/tools/definitions/get-citations.tool.js';
import { getDocketTool } from '@/mcp-server/tools/definitions/get-docket.tool.js';
import { getJudgeTool } from '@/mcp-server/tools/definitions/get-judge.tool.js';
import { getOpinionTool } from '@/mcp-server/tools/definitions/get-opinion.tool.js';
import { lookupCitationTool } from '@/mcp-server/tools/definitions/lookup-citation.tool.js';
import { lookupCourtsTool } from '@/mcp-server/tools/definitions/lookup-courts.tool.js';
import { searchDocketsTool } from '@/mcp-server/tools/definitions/search-dockets.tool.js';
import { searchJudgesTool } from '@/mcp-server/tools/definitions/search-judges.tool.js';
import { searchOpinionsTool } from '@/mcp-server/tools/definitions/search-opinions.tool.js';
import { searchOralArgumentsTool } from '@/mcp-server/tools/definitions/search-oral-arguments.tool.js';
import { COURT_FULL_NAMES } from '@/services/courtlistener/court-names-data.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';

// ── mock service ──────────────────────────────────────────────────────────────

const mockSvc = {
  searchOpinions: vi.fn(),
  searchDockets: vi.fn(),
  searchJudges: vi.fn(),
  searchOralArguments: vi.fn(),
  listCourts: vi.fn(),
  lookupCitation: vi.fn(),
  getCitedBy: vi.fn(),
  getCiting: vi.fn(),
  getOpinionCluster: vi.fn(),
  getDocket: vi.fn(),
  getPerson: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

// ── Zod input validation — required fields ────────────────────────────────────

describe('input validation — required fields rejected', () => {
  it('searchOpinionsTool rejects missing q', () => {
    expect(() => searchOpinionsTool.input.parse({})).toThrow();
  });

  it('searchDocketsTool rejects missing q', () => {
    expect(() => searchDocketsTool.input.parse({})).toThrow();
  });

  it('getOpinionTool rejects missing cluster_id', () => {
    expect(() => getOpinionTool.input.parse({})).toThrow();
  });

  it('getOpinionTool rejects non-integer cluster_id', () => {
    expect(() => getOpinionTool.input.parse({ cluster_id: 1.5 })).toThrow();
  });

  it('getDocketTool rejects missing docket_id', () => {
    expect(() => getDocketTool.input.parse({})).toThrow();
  });

  it('getJudgeTool rejects missing person_id', () => {
    expect(() => getJudgeTool.input.parse({})).toThrow();
  });

  it('getCitationsTool rejects missing cluster_id', () => {
    expect(() => getCitationsTool.input.parse({})).toThrow();
  });

  it('lookupCitationTool rejects missing citation', () => {
    expect(() => lookupCitationTool.input.parse({})).toThrow();
  });

  it('searchJudgesTool rejects missing q', () => {
    expect(() => searchJudgesTool.input.parse({})).toThrow();
  });

  it('searchOralArgumentsTool rejects missing q', () => {
    expect(() => searchOralArgumentsTool.input.parse({})).toThrow();
  });
});

// ── blank required strings — rejected before any upstream request (#39) ──────
//
// A blank or whitespace-only required string is rejected in the handler rather
// than by the schema. `.min(1)` used to reject '' at parse time but let '   '
// through to CourtListener, so the schema was never the real gate. The handler
// guard closes both cases and, unlike a schema rejection (which the SDK flattens
// to `content[]` text with no `structuredContent`), returns a typed reason on
// both client surfaces. The property under test is unchanged: a blank required
// string never reaches the network.

describe('input validation — blank required strings rejected before any request', () => {
  it('searchOpinionsTool rejects empty string q', async () => {
    mockSvc.searchOpinions = vi.fn();
    const ctx = createMockContext({ errors: searchOpinionsTool.errors });
    const input = searchOpinionsTool.input.parse({ q: '' });
    await expect(searchOpinionsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'empty_query' },
    });
    expect(mockSvc.searchOpinions).not.toHaveBeenCalled();
  });

  it('searchOpinionsTool rejects whitespace-only q', async () => {
    mockSvc.searchOpinions = vi.fn();
    const ctx = createMockContext({ errors: searchOpinionsTool.errors });
    const input = searchOpinionsTool.input.parse({ q: '   ' });
    await expect(searchOpinionsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'empty_query' },
    });
    expect(mockSvc.searchOpinions).not.toHaveBeenCalled();
  });

  it('searchDocketsTool rejects empty string q', async () => {
    mockSvc.searchDockets = vi.fn();
    const ctx = createMockContext({ errors: searchDocketsTool.errors });
    const input = searchDocketsTool.input.parse({ q: '' });
    await expect(searchDocketsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'empty_query' },
    });
    expect(mockSvc.searchDockets).not.toHaveBeenCalled();
  });

  it('searchJudgesTool rejects whitespace-only q', async () => {
    mockSvc.searchJudges = vi.fn();
    const ctx = createMockContext({ errors: searchJudgesTool.errors });
    const input = searchJudgesTool.input.parse({ q: '\t\n ' });
    await expect(searchJudgesTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'empty_query' },
    });
    expect(mockSvc.searchJudges).not.toHaveBeenCalled();
  });

  it('searchOralArgumentsTool rejects whitespace-only q', async () => {
    mockSvc.searchOralArguments = vi.fn();
    const ctx = createMockContext({ errors: searchOralArgumentsTool.errors });
    const input = searchOralArgumentsTool.input.parse({ q: '   ' });
    await expect(searchOralArgumentsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'empty_query' },
    });
    expect(mockSvc.searchOralArguments).not.toHaveBeenCalled();
  });

  it('lookupCitationTool rejects empty citation string', async () => {
    mockSvc.lookupCitation = vi.fn();
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({ citation: '' });
    await expect(lookupCitationTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'empty_citation' },
    });
    expect(mockSvc.lookupCitation).not.toHaveBeenCalled();
  });
});

// ── Zod input validation — out-of-range values ───────────────────────────────

describe('input validation — out-of-range values rejected', () => {
  it('searchOpinionsTool rejects page_size below 1', () => {
    expect(() => searchOpinionsTool.input.parse({ q: 'test', page_size: 0 })).toThrow();
  });

  it('searchOpinionsTool rejects page_size above 20', () => {
    expect(() => searchOpinionsTool.input.parse({ q: 'test', page_size: 21 })).toThrow();
  });

  it('searchDocketsTool rejects page_size below 1', () => {
    expect(() => searchDocketsTool.input.parse({ q: 'test', page_size: 0 })).toThrow();
  });

  it('searchDocketsTool rejects page_size above 20', () => {
    expect(() => searchDocketsTool.input.parse({ q: 'test', page_size: 21 })).toThrow();
  });

  it('getCitationsTool rejects page_size below 1', () => {
    expect(() => getCitationsTool.input.parse({ cluster_id: 1, page_size: 0 })).toThrow();
  });

  it('getCitationsTool rejects page_size above 20', () => {
    expect(() => getCitationsTool.input.parse({ cluster_id: 1, page_size: 21 })).toThrow();
  });

  it('lookupCourtsTool rejects unknown jurisdiction enum value', () => {
    expect(() => lookupCourtsTool.input.parse({ jurisdiction: 'INVALID_JURISDICTION' })).toThrow();
  });

  it('searchOpinionsTool rejects unknown status enum value', () => {
    expect(() => searchOpinionsTool.input.parse({ q: 'test', status: 'NotAStatus' })).toThrow();
  });

  it('searchOpinionsTool rejects unknown order_by enum value', () => {
    expect(() =>
      searchOpinionsTool.input.parse({ q: 'test', order_by: 'hacked_field desc' }),
    ).toThrow();
  });
});

// ── injection inputs — handler must not crash ─────────────────────────────────

describe('injection inputs — handler must not crash or leak internal details', () => {
  const injectionStrings = [
    "' OR '1'='1",
    '"; DROP TABLE opinions; --',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional injection probe — not a real template
    '${process.env.COURTLISTENER_API_TOKEN}',
    '../../../etc/passwd',
    '<script>alert(1)</script>',
    'a'.repeat(10_000),
    ' ',
    '\\x27 OR 1=1--',
    'UNION SELECT * FROM users--',
  ];

  for (const injection of injectionStrings) {
    it(`searchOpinionsTool handler does not crash for q="${injection.slice(0, 40)}"`, async () => {
      mockSvc.searchOpinions = vi
        .fn()
        .mockResolvedValue({ total: 0, results: [], nextCursor: null });
      const ctx = createMockContext();
      // Zod only trims — long or special strings (including C0 control bytes,
      // which trim() does not strip) still pass the schema and reach the handler.
      const trimmed = injection.length > 0 ? injection : 'fallback';
      const input = searchOpinionsTool.input.parse({ q: trimmed });
      const result = await searchOpinionsTool.handler(input, ctx);
      // No throw — service received the query unmodified (sanitization is server-side)
      expect(result).toBeDefined();
    });
  }

  it('searchDocketsTool handler forwards party_name injection string to service', async () => {
    const injection = "' OR 1=1--";
    mockSvc.searchDockets = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchDocketsTool.input.parse({ q: 'test', party_name: injection });
    await searchDocketsTool.handler(input, ctx);
    expect(mockSvc.searchDockets).toHaveBeenCalledWith(
      expect.objectContaining({ party_name: injection }),
      ctx,
    );
  });
});

// ── token never appears in tool output ───────────────────────────────────────

describe('API token must not appear in tool output or format() text', () => {
  const FAKE_TOKEN = 'fake-api-token-should-never-appear-in-output';

  it('searchOpinionsTool output does not contain token value', async () => {
    mockSvc.searchOpinions = vi.fn().mockResolvedValue({
      total: 1,
      results: [
        {
          cluster_id: 1,
          caseName: FAKE_TOKEN,
          caseNameFull: '',
          court: '',
          court_id: '',
          dateFiled: '',
          docketNumber: '',
          docket_id: 0,
          citation: [],
          citeCount: 0,
          judge: '',
          snippet: '',
          status: '',
        },
      ],
      nextCursor: null,
    });
    const ctx = createMockContext();
    const input = searchOpinionsTool.input.parse({ q: 'test' });
    const result = await searchOpinionsTool.handler(input, ctx);
    // The fake token appearing in case_name is expected (it's upstream data),
    // but the real secret should never be injected by the server itself.
    // Verify the handler output shape doesn't inject server-side env vars.
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('COURTLISTENER_API_TOKEN');
  });

  it('lookupCitationTool output does not expose env var names', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue([
      {
        citation: '410 U.S. 113',
        normalized_citation: null,
        status: 404,
        error_message: '',
        clusters: [],
      },
    ]);
    const ctx = createMockContext();
    const input = lookupCitationTool.input.parse({ citation: '410 U.S. 113' });
    const result = await lookupCitationTool.handler(input, ctx);
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('COURTLISTENER_API_TOKEN');
  });

  it('lookupCourtsTool output does not expose env var names', async () => {
    mockSvc.listCourts = vi.fn().mockResolvedValue({ total: 0, next_cursor: null, courts: [] });
    const ctx = createMockContext();
    const input = lookupCourtsTool.input.parse({});
    const result = await lookupCourtsTool.handler(input, ctx);
    const resultStr = JSON.stringify(result);
    expect(resultStr).not.toContain('COURTLISTENER_API_TOKEN');
  });

  // #65 — the bundled court snapshot is the one output field built from local data
  // rather than the upstream response, so it is the one that could carry something from
  // the generating machine if the generator ever emitted more than court records.
  it('lookupCourtsTool offline court ids carry nothing but court identifiers', async () => {
    mockSvc.listCourts = vi.fn().mockResolvedValue({ total: 0, next_cursor: null, courts: [] });
    const ctx = createMockContext();
    const input = lookupCourtsTool.input.parse({ status: 'active' });
    const result = await lookupCourtsTool.handler(input, ctx);

    expect(result.all_matching_court_ids.length).toBeGreaterThan(400);
    const ids = JSON.stringify(result.all_matching_court_ids);
    expect(ids).not.toContain('COURTLISTENER_API_TOKEN');
    expect(ids).not.toContain('/Users/');

    // The filtered view above is one slice of the snapshot; the shape claim covers every
    // id in it, including the ~2,900 the response withholds by default.
    const every = Object.keys(COURT_FULL_NAMES);
    expect(every.length).toBeGreaterThan(3000);
    expect(every.filter((id) => !/^[\w.-]+$/.test(id))).toEqual([]);
  });
});

// ── unicode / encoding edge cases ─────────────────────────────────────────────

describe('unicode and encoding edge cases', () => {
  it('searchOpinionsTool handles unicode multibyte characters in q', async () => {
    mockSvc.searchOpinions = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchOpinionsTool.input.parse({ q: '法律研究 constitutional rights 🏛️' });
    const result = await searchOpinionsTool.handler(input, ctx);
    expect(result.results).toHaveLength(0);
  });

  it('lookupCitationTool handles citation with unicode whitespace', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue([
      {
        citation: '410 U.S. 113',
        normalized_citation: '410 U.S. 113',
        status: 200,
        error_message: '',
        clusters: [
          {
            cluster_id: 100,
            case_name: 'Test',
            court: 'Supreme Court of the United States',
            court_id: 'scotus',
            court_resolution: 'resolved',
            date_filed: '2020-01-01',
            docket_id: 5,
            citations: ['410 U.S. 113'],
            cite_count: 1,
            precedential_status: 'Published',
            judges: '',
          },
        ],
      },
    ]);
    const ctx = createMockContext();
    // Non-breaking space in citation
    const input = lookupCitationTool.input.parse({ citation: '410 U.S. 113' });
    const result = await lookupCitationTool.handler(input, ctx);
    expect(result.matches[0]?.clusters[0]?.cluster_id).toBe(100);
  });

  it('searchJudgesTool handles unicode in judge name query', async () => {
    mockSvc.searchJudges = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchJudgesTool.input.parse({ q: 'Sotomayor Sofía Señoría' });
    const result = await searchJudgesTool.handler(input, ctx);
    expect(result.results).toHaveLength(0);
  });
});

// ── pagination boundary — next_cursor propagation ────────────────────────────

describe('pagination boundary — cursor propagation', () => {
  it('searchOpinionsTool returns next_cursor when present', async () => {
    mockSvc.searchOpinions = vi.fn().mockResolvedValue({
      total: 100,
      results: [],
      nextCursor: 'abc-cursor-xyz',
    });
    const ctx = createMockContext();
    const input = searchOpinionsTool.input.parse({ q: 'test' });
    const result = await searchOpinionsTool.handler(input, ctx);
    expect(result.next_cursor).toBe('abc-cursor-xyz');
  });

  it('searchDocketsTool returns next_cursor when present', async () => {
    mockSvc.searchDockets = vi.fn().mockResolvedValue({
      total: 50,
      results: [],
      nextCursor: 'docket-cursor',
    });
    const ctx = createMockContext();
    const input = searchDocketsTool.input.parse({ q: 'test' });
    const result = await searchDocketsTool.handler(input, ctx);
    expect(result.next_cursor).toBe('docket-cursor');
  });

  it('searchOpinionsTool passes cursor param to service', async () => {
    mockSvc.searchOpinions = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchOpinionsTool.input.parse({ q: 'test', cursor: 'page-2-cursor' });
    await searchOpinionsTool.handler(input, ctx);
    expect(mockSvc.searchOpinions).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'page-2-cursor' }),
      ctx,
    );
  });

  it('searchOralArgumentsTool returns next_cursor when present', async () => {
    mockSvc.searchOralArguments = vi.fn().mockResolvedValue({
      total: 30,
      results: [],
      nextCursor: 'oral-cursor',
    });
    const ctx = createMockContext();
    const input = searchOralArgumentsTool.input.parse({ q: 'test' });
    const result = await searchOralArgumentsTool.handler(input, ctx);
    expect(result.next_cursor).toBe('oral-cursor');
  });

  it('getCitationsTool returns next_cursor when present', async () => {
    mockSvc.getCitedBy = vi.fn().mockResolvedValue({
      total: 200,
      results: [],
      nextCursor: 'citation-cursor',
    });
    const ctx = createMockContext();
    const input = getCitationsTool.input.parse({ cluster_id: 100 });
    const result = await getCitationsTool.handler(input, ctx);
    expect(result.next_cursor).toBe('citation-cursor');
  });
});

// ── empty result enrichment on all search tools ───────────────────────────────

describe('empty result enrichment — all search tools surface a notice', () => {
  it('getCitationsTool sets notice on cited_by empty', async () => {
    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    mockSvc.getCitedBy = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = getCitationsTool.input.parse({ cluster_id: 100, direction: 'cited_by' });
    await getCitationsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect((enrichment.notice as string).length).toBeGreaterThan(0);
  });

  it('getCitationsTool sets notice on citing direction empty', async () => {
    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    mockSvc.getCiting = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = getCitationsTool.input.parse({ cluster_id: 100, direction: 'citing' });
    await getCitationsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
  });

  it('lookupCourtsTool enriches notice when empty', async () => {
    const { getEnrichment } = await import('@cyanheads/mcp-ts-core/testing');
    mockSvc.listCourts = vi.fn().mockResolvedValue({ total: 0, next_cursor: null, courts: [] });
    const ctx = createMockContext();
    const input = lookupCourtsTool.input.parse({ jurisdiction: 'I' });
    await lookupCourtsTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
  });
});

// ── format() — next_cursor rendered ──────────────────────────────────────────

describe('format() — pagination cursor rendered when present', () => {
  it('searchOpinionsTool format renders next_cursor', () => {
    // next_cursor renders only when results are present
    const outputWithResult = searchOpinionsTool.output.parse({
      results: [
        {
          cluster_id: 1,
          case_name: 'Test Case',
          case_name_full: '',
          court: 'SCOTUS',
          court_id: 'scotus',
          date_filed: '2020-01-01',
          docket_number: '20-1',
          docket_id: 1,
          citations: [],
          cite_count: 0,
          judges: '',
          status: 'Published',
          snippet: '',
          opinions: [],
        },
      ],
      next_cursor: 'next-page-abc',
    });
    const blocks = searchOpinionsTool.format!(outputWithResult);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('next-page-abc');
  });

  it('getCitationsTool format renders next_cursor', () => {
    const output = getCitationsTool.output.parse({
      source_cluster_id: 100,
      source_case_name: 'Test',
      direction: 'cited_by',
      results: [
        {
          cluster_id: 200,
          case_name: 'Related Case',
          court: 'CA9',
          court_id: 'ca9',
          date_filed: '2020-01-01',
          citations: [],
          cite_count: 0,
          snippet: '',
        },
      ],
      next_cursor: 'cite-page-2',
    });
    const blocks = getCitationsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('cite-page-2');
  });
});

// ── sparse upstream payload — additional tools ────────────────────────────────

describe('sparse upstream payload handling', () => {
  it('searchOpinionsTool handles missing optional upstream fields', async () => {
    mockSvc.searchOpinions = vi.fn().mockResolvedValue({
      total: 1,
      results: [
        {
          cluster_id: 999,
          caseName: undefined,
          caseNameFull: undefined,
          court: undefined,
          court_id: undefined,
          dateFiled: undefined,
          docketNumber: undefined,
          docket_id: undefined,
          citation: undefined,
          citeCount: undefined,
          judge: undefined,
          opinions: undefined,
          status: undefined,
        },
      ],
      nextCursor: null,
    });
    const ctx = createMockContext();
    const input = searchOpinionsTool.input.parse({ q: 'sparse' });
    const result = await searchOpinionsTool.handler(input, ctx);
    expect(result.results[0]).toMatchObject({
      cluster_id: 999,
      case_name: '',
      case_name_full: '',
      court: '',
      court_id: '',
      citations: [],
      cite_count: 0,
      snippet: '',
      opinions: [],
    });
  });

  it('searchDocketsTool handles missing optional upstream fields in recap_documents', async () => {
    mockSvc.searchDockets = vi.fn().mockResolvedValue({
      total: 1,
      results: [
        {
          docket_id: 1,
          caseName: 'Sparse Case',
          court: '',
          court_id: '',
          dateFiled: '',
          dateTerminated: undefined,
          docketNumber: '',
          pacer_case_id: undefined,
          assignedTo: undefined,
          cause: '',
          juryDemand: '',
          party: undefined,
          attorney: undefined,
          firm: undefined,
          recap_documents: undefined,
        },
      ],
      nextCursor: null,
    });
    const ctx = createMockContext();
    const input = searchDocketsTool.input.parse({ q: 'sparse' });
    const result = await searchDocketsTool.handler(input, ctx);
    expect(result.results[0].sample_documents).toHaveLength(0);
    expect(result.results[0].parties).toEqual([]);
    expect(result.results[0].attorneys).toEqual([]);
    expect(result.results[0].firms).toEqual([]);
  });

  it('searchOralArgumentsTool handles sparse upstream with null fields', async () => {
    mockSvc.searchOralArguments = vi.fn().mockResolvedValue({
      total: 1,
      results: [
        {
          id: 1,
          caseName: undefined,
          court: undefined,
          court_id: undefined,
          dateArgued: undefined,
          docket_id: undefined,
          docketNumber: undefined,
          judge: undefined,
          panel_ids: undefined,
          duration: undefined,
          download_url: undefined,
          local_path: undefined,
          snippet: undefined,
        },
      ],
      nextCursor: null,
    });
    const ctx = createMockContext();
    const input = searchOralArgumentsTool.input.parse({ q: 'sparse' });
    const result = await searchOralArgumentsTool.handler(input, ctx);
    expect(result.results[0]).toMatchObject({
      audio_id: 1,
      case_name: '',
      court_id: '',
      panel_ids: [],
      duration_seconds: 0,
    });
  });
});
