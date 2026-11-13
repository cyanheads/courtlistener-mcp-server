/**
 * @fileoverview Search filters, highlighting, and selected output fields through the HTTP boundary.
 * @module tests/tools/search-options-contracts.test
 */

import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCitationsTool } from '@/mcp-server/tools/definitions/get-citations.tool.js';
import { searchDocketsTool } from '@/mcp-server/tools/definitions/search-dockets.tool.js';
import { searchFinancialDisclosuresTool } from '@/mcp-server/tools/definitions/search-financial-disclosures.tool.js';
import { searchJudgesTool } from '@/mcp-server/tools/definitions/search-judges.tool.js';
import { searchOpinionsTool } from '@/mcp-server/tools/definitions/search-opinions.tool.js';
import { searchOralArgumentsTool } from '@/mcp-server/tools/definitions/search-oral-arguments.tool.js';
import {
  disposeCourtListenerService,
  initCourtListenerService,
} from '@/services/courtlistener/courtlistener-service.js';

const requests: URL[] = [];
const next = 'https://www.courtlistener.com/api/rest/v4/search/?cursor=continuation';
let rows: object[];

beforeEach(() => {
  requests.length = 0;
  rows = [];
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input);
    requests.push(url);
    if (url.pathname.endsWith('/clusters/1/')) return Response.json({ id: 1, case_name: 'Test' });
    if (url.pathname.endsWith('/opinions/'))
      return Response.json({
        next: null,
        results: [
          {
            id: 10,
            opinions_cited: [
              'https://www.courtlistener.com/api/rest/v4/opinions/11/',
              'https://www.courtlistener.com/api/rest/v4/opinions/12/',
            ],
          },
        ],
      });
    if (url.pathname.endsWith('/search/'))
      return Response.json({ count: rows.length, next, results: rows });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  initCourtListenerService(
    {
      apiToken: 'test-token',
      mcpServerVersion: '0.0.0',
      rateLimitPerMinute: 10000,
      rateLimitPerHour: 100000,
    },
    createInMemoryStorage(),
  );
});

afterEach(() => {
  disposeCourtListenerService();
  vi.unstubAllGlobals();
});

describe('citation search contract', () => {
  it('preserves outbound ID slices, totals, snippets and continuation with the default status', async () => {
    rows = [{ cluster_id: 101, opinions: [{ id: 12, snippet: 'Opening text' }] }];
    const result = await runToolContract(getCitationsTool, {
      cluster_id: 1,
      direction: 'citing',
      cursor: '1',
      page_size: 1,
    });
    expect(requests.at(-1)?.searchParams.get('q')).toBe('id:(12)');
    expect(requests.at(-1)?.searchParams.has('highlight')).toBe(false);
    expect(
      [...requests.at(-1)!.searchParams.keys()].filter((key) => key.startsWith('stat_')),
    ).toEqual([]);
    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      next_cursor: null,
      results: [{ snippet: 'Opening text' }],
    });
    expect(JSON.stringify(result.content)).toContain('Opening text');
  });

  it('uses every selected status and the upper date and order on inbound continuation', async () => {
    await runToolContract(getCitationsTool, {
      cluster_id: 1,
      statuses: [
        'Published',
        'Unpublished',
        'Errata',
        'Separate',
        'In-chambers',
        'Relating-to',
        'Unknown',
      ],
      filed_before: '2025-03-21',
      order_by: 'citeCount desc',
      cursor: 'continuation',
    });
    const query = requests.at(-1)?.searchParams;
    expect(requests).toHaveLength(3);
    expect(
      Object.fromEntries([...query!.entries()].filter(([key]) => key.startsWith('stat_'))),
    ).toEqual({
      stat_Published: 'on',
      stat_Unpublished: 'on',
      stat_Errata: 'on',
      stat_Separate: 'on',
      'stat_In-chambers': 'on',
      'stat_Relating-to': 'on',
      stat_Unknown: 'on',
    });
    expect(query?.get('order_by')).toBe('citeCount desc');
    expect(query?.get('filed_before')).toBe('2025-03-21');
    expect(query?.get('cursor')).toBe('continuation');
  });

  it('keeps a status-filtered empty outbound page distinguishable from exhaustion', async () => {
    const result = await runToolContract(getCitationsTool, {
      cluster_id: 1,
      direction: 'citing',
      page_size: 1,
      statuses: ['Unpublished'],
      filed_before: '2025-03-21',
      court: 'CA9, newCourtZZ',
    });
    expect(requests.at(-1)?.searchParams.get('stat_Unpublished')).toBe('on');
    expect(requests.at(-1)?.searchParams.has('stat_Published')).toBe(false);
    expect(requests.at(-1)?.searchParams.get('filed_before')).toBe('2025-03-21');
    expect(requests.at(-1)?.searchParams.get('court')).toBe('ca9 newCourtZZ');
    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      next_cursor: '1',
      notice: expect.stringContaining('more pages remain'),
      results: [],
    });
    expect(JSON.stringify(result.content)).toContain('more pages remain');
    expect(JSON.stringify(result.content)).toContain('courtlistener_lookup_courts');
  });

  it('recognizes a citing offset past the end without a search request', async () => {
    const result = await runToolContract(getCitationsTool, {
      cluster_id: 1,
      direction: 'citing',
      cursor: '2',
      statuses: ['Published'],
    });
    expect(requests).toHaveLength(2);
    expect(result.structuredContent).toMatchObject({
      totalCount: 2,
      next_cursor: null,
      results: [],
    });
    expect(JSON.stringify(result.content)).not.toContain('more pages remain');
  });

  it('rejects an empty status selector without using the Published default', async () => {
    const result = await runToolContract(getCitationsTool, { cluster_id: 1, statuses: [] });
    expect(result.isError).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it.each([
    {
      input: { direction: 'citing', order_by: 'citeCount desc' },
      reason: 'unsupported_citation_order',
      hint: 'Omit order_by for citing or use the cited_by direction.',
    },
    {
      input: { filed_before: '2024-02-31' },
      reason: 'invalid_date',
      hint: 'Pass each date filter as a real YYYY-MM-DD calendar date, for example 2020-01-01.',
    },
  ] as const)(
    'rejects $reason before retrieving variants and explains recovery',
    async ({ input, reason, hint }) => {
      const result = await runToolContract(getCitationsTool, { cluster_id: 1, ...input });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason, recovery: { hint } } },
      });
      expect(JSON.stringify(result.content)).toContain(hint);
      expect(requests).toHaveLength(0);
    },
  );
});

describe('search projections and filter forwarding', () => {
  it.each([searchOpinionsTool, searchDocketsTool, searchJudgesTool, searchOralArgumentsTool])(
    'normalizes the court parameter of $name and reports snapshot misses on empty results',
    async (tool) => {
      const result = await runToolContract(tool, { q: '*', court: 'SCOTUS, ca9\tnewCourtZZ' });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.searchParams.get('q')).toBe('*');
      expect(requests[0]?.searchParams.get('court')).toBe('scotus ca9 newCourtZZ');
      expect(result.structuredContent).toMatchObject({
        notice: expect.stringContaining('newCourtZZ'),
        next_cursor: 'continuation',
      });
      expect(JSON.stringify(result.content)).toContain('courtlistener_lookup_courts');
      expect(JSON.stringify(result.content)).toContain('**Next page cursor:** `continuation`');
    },
  );

  it('requests opinion excerpts and preserves selected cited IDs only when included', async () => {
    rows = [
      {
        cluster_id: 1,
        caseName: '<mark>Alpha</mark> v. Beta',
        citation: ['<mark>123</mark> U.S. 5'],
        court_id: 'newcourtzz',
        opinions: [
          { id: 10 },
          { id: 20, snippet: 'The <mark>proof</mark> &amp; record', cites: [77, 88] },
        ],
      },
    ];
    const base = await runToolContract(searchOpinionsTool, { q: 'proof', court: 'NEWCOURTZZ' });
    expect(requests[0]?.searchParams.get('highlight')).toBe('on');
    expect(base.structuredContent).toMatchObject({
      results: [
        {
          case_name: 'Alpha v. Beta',
          citations: ['123 U.S. 5'],
          court_id: 'newcourtzz',
          snippet: 'The proof & record',
        },
      ],
      next_cursor: 'continuation',
    });
    expect(base.structuredContent).not.toHaveProperty('results.0.opinions.1.cites');
    expect(JSON.stringify(base.content)).toContain('The proof');
    expect(JSON.stringify(base.content)).not.toContain('77, 88');
    const selected = await runToolContract(searchOpinionsTool, { q: 'proof', include: ['cites'] });
    expect(selected.structuredContent).toMatchObject({
      results: [
        {
          opinions: [
            { id: 10, cites: [] },
            { id: 20, cites: [77, 88] },
          ],
        },
      ],
    });
    expect(JSON.stringify(selected.content)).toContain('77, 88');
  });

  it('preserves exact known mixed-case IDs and caller casing for new courts', async () => {
    rows = [{ cluster_id: 1, court_id: 'newCourtZZ' }];
    const result = await runToolContract(searchOpinionsTool, {
      q: '*',
      court: 'txctapp13A, TXCTAPP13b newCourtZZ',
    });
    expect(requests[0]?.searchParams.get('court')).toBe('txctapp13A txctapp13B newCourtZZ');
    expect(result.structuredContent).toMatchObject({ results: [{ court_id: 'newCourtZZ' }] });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('advertises available filters and the distinction between source and indexed results', () => {
    expect(searchJudgesTool.description).not.toMatch(/demographic/i);
    expect(searchFinancialDisclosuresTool.description).toContain(
      'courtlistener_get_financial_disclosure',
    );
    expect(searchDocketsTool.enrichment?.totalCount.description).toMatch(/estimates/i);
  });

  it('requests oral context and keeps marked metadata readable', async () => {
    rows = [
      {
        id: 10,
        caseName: 'A v. <mark>B</mark>',
        docketNumber: '2-<mark>20</mark>',
        judge: '<mark>Jones</mark>',
        snippet: 'Evidence of <mark>harm</mark>.',
      },
    ];
    const result = await runToolContract(searchOralArgumentsTool, { q: 'harm' });
    expect(requests[0]?.searchParams.get('highlight')).toBe('on');
    expect(result.structuredContent).toMatchObject({
      results: [
        {
          case_name: 'A v. B',
          docket_number: '2-20',
          judges: 'Jones',
          snippet: 'Evidence of harm.',
        },
      ],
    });
    expect(JSON.stringify(result.content)).not.toContain('<mark>');
    expect(JSON.stringify(result.content)).toContain('Evidence of harm');
  });

  it('defaults to indexed docket counts, with only selected rosters on both surfaces', async () => {
    rows = [
      {
        docket_id: 1,
        party: ['Party One'],
        attorney: ['Lawyer A', 'Lawyer B'],
        firm: [],
        recap_documents: [{ id: 3, description: 'Matched filing' }],
      },
      { docket_id: 2 },
    ];
    const base = await runToolContract(searchDocketsTool, { q: 'case' });
    expect(base.structuredContent).toMatchObject({
      results: [
        { party_count: 1, attorney_count: 2, firm_count: 0, sample_documents: [{ id: 3 }] },
        { party_count: null, attorney_count: null, firm_count: null },
      ],
      next_cursor: 'continuation',
    });
    expect(base.structuredContent).not.toHaveProperty('results.0.parties');
    expect(JSON.stringify(base.content)).toContain('Matched filing');
    expect(JSON.stringify(base.content)).not.toContain('Lawyer A');
    const selected = await runToolContract(searchDocketsTool, {
      q: 'case',
      include: ['attorneys', 'firms'],
    });
    expect(selected.structuredContent).toMatchObject({
      results: [
        { attorneys: ['Lawyer A', 'Lawyer B'], firms: [] },
        { attorneys: [], firms: [] },
      ],
    });
    expect(selected.structuredContent).not.toHaveProperty('results.0.parties');
    expect(JSON.stringify(selected.content)).toContain('Lawyer A, Lawyer B');
  });
});
