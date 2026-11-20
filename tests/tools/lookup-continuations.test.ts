/** @fileoverview Tool contract tests for snapshot fallback and lookup continuations. */
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getPartiesTool } from '@/mcp-server/tools/definitions/get-parties.tool.js';
import { lookupCitationTool } from '@/mcp-server/tools/definitions/lookup-citation.tool.js';
import { lookupCourtsTool } from '@/mcp-server/tools/definitions/lookup-courts.tool.js';
import {
  disposeCourtListenerService,
  initCourtListenerService,
} from '@/services/courtlistener/courtlistener-service.js';

beforeEach(() => {
  initCourtListenerService(
    {
      apiToken: 'fixture',
      mcpServerVersion: 'test',
      rateLimitPerHour: 10000,
      rateLimitPerMinute: 10000,
    },
    createInMemoryStorage(),
  );
});

afterEach(() => {
  disposeCourtListenerService();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('returns snapshot IDs when CourtListener throttles the live page', async () => {
  vi.stubGlobal('fetch', async () =>
    Response.json({ detail: 'Throttled' }, { status: 429, headers: { 'retry-after': '60' } }),
  );
  const result = await runToolContract(lookupCourtsTool, { jurisdiction: 'F' });
  expect(result.structuredContent).toMatchObject({
    all_matching_court_ids: expect.arrayContaining(['scotus']),
    courts: [],
    next_cursor: null,
    live_records: { status: 'unavailable', reason: 'rate_limited', retry_after_seconds: 60 },
  });
  expect(JSON.stringify(result.content)).toContain('rate_limited');
  expect(JSON.stringify(result.content)).toContain('60');
  expect(JSON.stringify(result.structuredContent)).not.toContain('totalCount');
});

it('returns the snapshot after upstream outage retries are exhausted', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => Response.json({ detail: 'Unavailable' }, { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  const pending = runToolContract(lookupCourtsTool, { jurisdiction: 'F' });
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(fetch.mock.calls.length).toBeGreaterThan(1);
  expect(result.structuredContent).toMatchObject({
    all_matching_court_ids: expect.arrayContaining(['scotus']),
    live_records: { status: 'unavailable', reason: 'service_unavailable' },
  });
  expect(JSON.stringify(result.content)).toContain('service_unavailable');
});

it('keeps an invalid live page as an error instead of falling back to the snapshot', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ detail: 'Invalid page' }, { status: 404 }));
  const result = await runToolContract(lookupCourtsTool, { page: 999 });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({ error: { data: { reason: 'not_found' } } });
  expect(JSON.stringify(result.content)).toContain('not_found');
});

it('distinguishes a fetched empty court page from skipped or unavailable records', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ count: 0, next: null, results: [] }));
  const result = await runToolContract(lookupCourtsTool, { jurisdiction: 'F' });
  expect(result.structuredContent).toMatchObject({
    courts: [],
    next_cursor: null,
    live_records: { status: 'fetched' },
  });
  expect(JSON.stringify(result.content)).toContain('No courts matched the filters.');
});

it('skips the live call for snapshot-only lookups without reporting exhaustion', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ count: 0, next: null, results: [] }));
  vi.stubGlobal('fetch', fetch);
  const result = await runToolContract(lookupCourtsTool, { records: false, status: 'any' });
  expect(fetch).not.toHaveBeenCalled();
  expect(result.structuredContent).toMatchObject({
    all_matching_court_ids_complete: false,
    live_records: { status: 'skipped' },
    courts: [],
    next_cursor: null,
  });
  expect(JSON.stringify(result.content)).toContain('skipped');
});

it('spends at most twenty distinct docket lookups when the requested budget is higher', async () => {
  const dockets: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/citation-lookup/')) {
      return Response.json([
        {
          citation: '410 U.S. 113',
          status: 300,
          normalized_citations: ['410 U.S. 113'],
          clusters: Array.from({ length: 21 }, (_, index) => ({
            id: index + 1,
            docket_id: index + 1,
          })),
        },
      ]);
    }
    dockets.push(path);
    return Response.json({ court_id: 'scotus' });
  });
  const result = await runToolContract(lookupCitationTool, {
    citation: '410 U.S. 113',
    max_court_lookups: 21,
  });
  expect(dockets).toHaveLength(20);
  expect(new Set(dockets).size).toBe(20);
  expect(result.structuredContent).toMatchObject({
    matches: [
      {
        clusters: expect.arrayContaining([
          expect.objectContaining({
            cluster_id: 21,
            docket_id: 21,
            court: null,
            court_id: null,
            court_resolution: 'over_budget',
          }),
        ]),
      },
    ],
  });
  expect(JSON.stringify(result.content)).toContain('over_budget');
});

function stubRoster() {
  const urls: URL[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const request = new URL(url);
    urls.push(request);
    if (request.pathname.endsWith('/parties/')) {
      return Response.json({
        count: 1,
        next: null,
        results: [
          {
            id: 1,
            name: 'Party',
            party_types: [],
            attorneys: [1, 6].map((id) => ({ attorney_id: id, docket_id: 25 })),
          },
        ],
      });
    }
    const id = Number(request.searchParams.get('cursor') ?? '1');
    return Response.json({
      count: 6,
      next: id < 6 ? `https://www.courtlistener.com/api/rest/v4/attorneys/?cursor=${id + 1}` : null,
      results: [{ id, name: `Counsel ${id}`, contact_raw: `Contact ${id}` }],
    });
  });
  return urls;
}

it('caps the first attorney roster window at five pages', async () => {
  const urls = stubRoster();
  const result = await runToolContract(getPartiesTool, { docket_id: 25, cursor: 'party-window' });
  expect(urls).toHaveLength(6);
  expect(result.structuredContent).toMatchObject({
    attorney_resolution: { status: 'capped', unresolved_ids: [6], next_cursor: '6' },
  });
});

it('resumes the roster independently of the parties cursor', async () => {
  const urls = stubRoster();
  const result = await runToolContract(getPartiesTool, {
    docket_id: 25,
    cursor: 'party-window',
    attorney_cursor: '6',
  });
  expect(urls.map((url) => url.searchParams.get('cursor'))).toEqual(['party-window', '6']);
  expect(result.structuredContent).toMatchObject({
    attorney_resolution: {
      status: 'exhausted',
      unresolved_ids: [1],
      next_cursor: null,
      continued: true,
    },
    parties: [
      {
        attorneys: [
          { attorney_id: 1, resolution: 'not_fetched' },
          { attorney_id: 6, resolution: 'resolved', name: 'Counsel 6', contact_raw: 'Contact 6' },
        ],
      },
    ],
  });
  expect(JSON.stringify(result.content)).toContain('Counsel 6');
  expect(JSON.stringify(result.content)).toContain('continued');
});
