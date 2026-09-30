/**
 * @fileoverview Search error contracts through real fetch, pacing, retry, and formatting.
 * @module tests/tools/search-query-contracts.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createInMemoryStorage,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCitationsTool } from '@/mcp-server/tools/definitions/get-citations.tool.js';
import { searchDocketsTool } from '@/mcp-server/tools/definitions/search-dockets.tool.js';
import { searchJudgesTool } from '@/mcp-server/tools/definitions/search-judges.tool.js';
import { searchOpinionsTool } from '@/mcp-server/tools/definitions/search-opinions.tool.js';
import { searchOralArgumentsTool } from '@/mcp-server/tools/definitions/search-oral-arguments.tool.js';
import {
  disposeCourtListenerService,
  getCourtListenerService,
  initCourtListenerService,
} from '@/services/courtlistener/courtlistener-service.js';

const searches = [searchOpinionsTool, searchDocketsTool, searchJudgesTool, searchOralArgumentsTool];
const detail = 'The query contains unbalanced parentheses.';
const queryDiagnostics = [
  detail,
  'The query contains unbalanced quotes.',
  'The query contains an unrecognized proximity token.',
  'The query contains a disallowed wildcard pattern.',
  'The date entered has an invalid format.',
];
const fetchStub = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchStub.mockReset();
  vi.stubGlobal('fetch', fetchStub);
  initCourtListenerService(
    {
      apiToken: 'fixture-token-never-in-output',
      mcpServerVersion: '0.0.0-test',
      rateLimitPerMinute: 10_000,
      rateLimitPerHour: 100_000,
    },
    createInMemoryStorage(),
  );
});

afterEach(() => {
  disposeCourtListenerService();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(searches)('$name characterization', (definition) => {
  it.each([0, 20])('preserves successful page with %i rows on both surfaces', async (count) => {
    fetchStub.mockImplementation(async () =>
      Response.json({
        count,
        next: count ? 'https://www.courtlistener.com/api/rest/v4/search/?cursor=next-page' : null,
        results: Array.from({ length: count }, (_, i) => ({
          id: i + 1,
          cluster_id: i + 1,
          docket_id: i + 1,
          caseName: `Case ${i}`,
          name: `Judge ${i}`,
        })),
      }),
    );
    const result = await runToolContract(definition, { q: 'case', page_size: 20 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      results: expect.any(Array),
      next_cursor: count ? 'next-page' : null,
      totalCount: count,
    });
    expect(result.structuredContent).toHaveProperty('results.length', count);
    const text = JSON.stringify(result.content);
    expect(text).toContain(`**Returned:** ${count}`);
    if (count) expect(text).toContain('next-page');
    else expect(result.structuredContent).toMatchObject({ notice: expect.any(String) });
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(new URL(String(fetchStub.mock.calls[0]![0])).searchParams.get('count')).toBe('20');
  });

  it('preserves an empty terminal cursor page', async () => {
    fetchStub.mockImplementation(async () => Response.json({ count: 21, next: null, results: [] }));
    const result = await runToolContract(definition, { q: 'case', cursor: 'past-end' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      results: [],
      next_cursor: null,
      totalCount: 21,
    });
    expect(JSON.stringify(result.content)).toContain('**Returned:** 0');
    expect(new URL(String(fetchStub.mock.calls[0]![0])).searchParams.get('cursor')).toBe(
      'past-end',
    );
  });

  it.each([
    ['unknown detail', JSON.stringify({ detail: 'Unknown query error' })],
    [
      'generic Elasticsearch error',
      JSON.stringify({ detail: 'Elasticsearch Bad request error. Please review your query.' }),
    ],
    ['form errors', JSON.stringify({ order_by: ['Select a valid choice.'] })],
    ['substring match', JSON.stringify({ detail: `prefix ${detail}` })],
    ['wrong case', JSON.stringify({ detail: detail.toUpperCase() })],
    ['non-string detail', JSON.stringify({ detail: [detail] })],
    ['nested detail', JSON.stringify({ error: { detail } })],
    ['array', JSON.stringify([{ detail }])],
    ['null', 'null'],
    ['string', JSON.stringify(detail)],
    ['prototype-shaped JSON', JSON.stringify({ __proto__: null, constructor: { detail } })],
    ['nested __proto__ detail', `{"__proto__":{"detail":"${detail}"}}`],
    ['HTML', `<html>${detail}</html>`],
    ['malformed JSON', `{"detail":"${detail}`],
    ['empty body', ''],
  ])('preserves generic HTTP 400 for %s', async (_name, body) => {
    fetchStub.mockImplementation(async () => new Response(body, { status: 400 }));
    const result = await runToolContract(definition, { q: 'case' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.InvalidParams,
        data: { status: 400, body, responseBody: body },
      },
    });
    expect(JSON.stringify(result)).not.toContain('invalid_query');
    expect(JSON.stringify(result.content)).toContain('Status: 400');
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('preserves a truncated error body without interpreting its embedded diagnostic', async () => {
    const body = JSON.stringify({ padding: 'x'.repeat(2000), detail });
    fetchStub.mockImplementation(async () => new Response(body, { status: 400 }));
    const result = await runToolContract(definition, { q: 'case' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams, data: { status: 400 } },
    });
    const { error } = result.structuredContent as { error: { data: { body: string } } };
    expect(error.data.body.length).toBeLessThan(body.length);
    expect(JSON.stringify(result)).not.toContain('invalid_query');
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('preserves the invalid-cursor 404 path', async () => {
    fetchStub.mockImplementation(async () =>
      Response.json({ detail: 'Invalid cursor' }, { status: 404 }),
    );
    const result = await runToolContract(definition, { q: 'case', cursor: 'invalid' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'not_found', path: '/search/' },
      },
    });
    expect(JSON.stringify(result.content)).toContain('Resource not found: /search/');
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it.each([{ q: ' ' }, { q: 'case', page_size: 21 }])(
    'rejects invalid local input %j before fetch',
    async (input) => {
      const result = await runToolContract(definition, input);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain('invalid_query');
      expect(fetchStub).not.toHaveBeenCalled();
    },
  );
});

describe('generated citation query characterization', () => {
  it.each(['cited_by', 'citing'] as const)(
    'retains HTTP400 classification for %s queries',
    async (direction) => {
      fetchStub.mockImplementation(async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/clusters/1/'))
          return Response.json({ id: 1, case_name: 'Source', sub_opinions: [] });
        if (path.endsWith('/opinions/'))
          return Response.json({
            count: 1,
            next: null,
            results: [
              { id: 2, opinions_cited: ['https://www.courtlistener.com/api/rest/v4/opinions/3/'] },
            ],
          });
        if (path.endsWith('/search/')) return Response.json({ detail }, { status: 400 });
        throw new Error(`Unexpected fixture path ${path}`);
      });
      const result = await runToolContract(getCitationsTool, { cluster_id: 1, direction });
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { status: 400 } },
      });
      expect(JSON.stringify(result)).not.toContain('invalid_query');
      expect(fetchStub).toHaveBeenCalledTimes(3);
    },
  );
});

describe.each(searches)('$name query-validation regressions (#70)', (definition) => {
  it.each(queryDiagnostics)('classifies the exact diagnostic: %s', async (diagnostic) => {
    fetchStub.mockImplementation(async () =>
      Response.json({ detail: diagnostic }, { status: 400 }),
    );
    const result = await runToolContract(definition, { q: 'private-query:(' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: expect.stringContaining(diagnostic),
        data: { status: 400, reason: 'invalid_query', retryable: false, detail: diagnostic },
      },
    });
    const contract = definition.errors?.find((entry) => entry.reason === 'invalid_query');
    expect(contract).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      retryable: false,
      thrownBy: 'service',
    });
    expect(result.structuredContent).toMatchObject({
      error: { data: { recovery: { hint: contract!.recovery } } },
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain(diagnostic);
    expect(text).toContain(contract!.recovery);
    expect(text).toContain('reason invalid_query');
    expect(text).toContain('not retryable');
    expect(JSON.stringify(result)).not.toContain('private-query');
    expect(JSON.stringify(result)).not.toContain('fixture-token-never-in-output');
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('returns only the recognized diagnostic, without unrelated upstream fields', async () => {
    fetchStub.mockImplementation(async () =>
      Response.json({ detail, private_debug: 'upstream-private-value' }, { status: 400 }),
    );
    const result = await runToolContract(definition, { q: 'case:(' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { detail, reason: 'invalid_query' } },
    });
    expect(JSON.stringify(result)).not.toContain('upstream-private-value');
    expect(fetchStub).toHaveBeenCalledOnce();
  });
});

describe('query classification boundaries', () => {
  it.each([500, 501])(
    'requires an untruncated diagnostic capture (%i byte response)',
    async (bytes) => {
      const base = JSON.stringify({ detail, padding: '' });
      const body = JSON.stringify({
        detail,
        padding: 'x'.repeat(bytes - new TextEncoder().encode(base).byteLength),
      });
      expect(new TextEncoder().encode(body).byteLength).toBe(bytes);
      fetchStub.mockImplementation(async () => new Response(body, { status: 400 }));
      const result = await runToolContract(searchOpinionsTool, { q: 'case:(' });
      expect(result.structuredContent).toMatchObject({
        error: {
          code: bytes === 500 ? JsonRpcErrorCode.ValidationError : JsonRpcErrorCode.InvalidParams,
        },
      });
      expect(JSON.stringify(result).includes('invalid_query')).toBe(bytes === 500);
      expect(fetchStub).toHaveBeenCalledOnce();
    },
  );

  it('retains actual HTTP400 in fetch diagnostics', async () => {
    const log = vi.spyOn(logger, 'error');
    fetchStub.mockImplementation(async () => Response.json({ detail }, { status: 400 }));
    const result = await runToolContract(searchOpinionsTool, { q: 'case:(' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError },
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('with status 400'),
      expect.objectContaining({
        extra: expect.objectContaining({ statusCode: 400, errorSource: 'FetchHttpError' }),
      }),
    );
  });

  it.each([
    [401, JsonRpcErrorCode.Unauthorized],
    [403, JsonRpcErrorCode.Forbidden],
    [422, JsonRpcErrorCode.ValidationError],
  ])('does not reclassify matching text on HTTP%i', async (status, code) => {
    fetchStub.mockImplementation(async () => Response.json({ detail }, { status }));
    const result = await runToolContract(searchOpinionsTool, { q: 'case:(' });
    expect(result.structuredContent).toMatchObject({ error: { code, data: { status } } });
    expect(JSON.stringify(result)).not.toContain('invalid_query');
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('does not classify matching text from REST list or POST endpoints', async () => {
    fetchStub.mockImplementation(async () => Response.json({ detail }, { status: 400 }));
    const svc = getCourtListenerService();
    const ctx = createMockContext();
    await expect(svc.listCourts({}, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { body: JSON.stringify({ detail }) },
    });
    await expect(svc.lookupCitation('410 U.S. 113', 0, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { body: JSON.stringify({ detail }) },
    });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it.each([
    { definition: searchOpinionsTool, input: { q: 'case', filed_after: '2020-02-31' } },
    { definition: searchDocketsTool, input: { q: 'case', filed_after: '2020-02-31' } },
    { definition: searchOralArgumentsTool, input: { q: 'case', argued_after: '2020-02-31' } },
  ])('keeps $definition.name date rejection local', async ({ definition, input }) => {
    const result = await runToolContract(definition, input);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_date' } },
    });
    expect(JSON.stringify(result.content)).toContain('YYYY-MM-DD');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it.each([undefined, '120'])(
    'retains fail-fast 429 recovery (Retry-After %s)',
    async (retryAfter) => {
      fetchStub.mockImplementation(async () =>
        Response.json(
          { detail },
          {
            status: 429,
            headers: retryAfter ? { 'Retry-After': retryAfter } : {},
          },
        ),
      );
      const result = await runToolContract(searchOpinionsTool, { q: 'case' });
      const hint = searchOpinionsTool.errors!.find(
        (entry) => entry.reason === 'rate_limited',
      )!.recovery;
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.RateLimited,
          data: { reason: 'rate_limited', retryable: false, recovery: { hint } },
        },
      });
      expect(JSON.stringify(result.content)).toContain(hint);
      if (retryAfter)
        expect(result.structuredContent).toMatchObject({ error: { data: { retryAfter } } });
      expect(fetchStub).toHaveBeenCalledOnce();
    },
  );

  it.each([429, 503])('retries HTTP%i then stops at a recognized query failure', async (status) => {
    vi.useFakeTimers();
    fetchStub
      .mockResolvedValueOnce(Response.json({}, { status, headers: { 'Retry-After': '1' } }))
      .mockImplementation(async () => Response.json({ detail }, { status: 400 }));
    const pending = runToolContract(searchOpinionsTool, { q: 'case:(' });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_query', retryable: false },
      },
    });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('preserves in-flight caller cancellation', async () => {
    vi.useFakeTimers();
    fetchStub.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
    const pending = runToolContract(
      searchOpinionsTool,
      { q: 'case' },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new DOMException('Cancelled', 'AbortError'));
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(JSON.stringify(result)).not.toContain('invalid_query');
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('keeps repeated fetch timeouts bounded by the request deadline', async () => {
    vi.useFakeTimers();
    fetchStub.mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          });
        }),
    );
    const started = Date.now();
    const pending = runToolContract(searchOpinionsTool, { q: 'case' });
    await vi.advanceTimersByTimeAsync(90_001);
    const result = await pending;
    expect(result.structuredContent).toMatchObject({ error: { code: JsonRpcErrorCode.Timeout } });
    expect(JSON.stringify(result)).not.toContain('invalid_query');
    expect(fetchStub.mock.calls.length).toBeGreaterThan(1);
    expect(fetchStub.mock.calls.length).toBeLessThanOrEqual(3);
    expect(Date.now() - started).toBe(90_001);
  });
});
