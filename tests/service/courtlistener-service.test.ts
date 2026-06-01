/**
 * @fileoverview Tests for the CourtListener service — error classification,
 * pagination cursor extraction, token/secret hygiene, and network-failure paths.
 * All tests mock `withRetry` and `fetchWithTimeout` to avoid network calls and
 * retry delays.
 * @module tests/service/courtlistener-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock withRetry to execute the fn directly (no retries, no backoff) and
// fetchWithTimeout to delegate to the mocked global fetch.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return {
    ...original,
    withRetry: async (fn: () => Promise<unknown>) => fn(),
    fetchWithTimeout: (url: string, _timeout: number, _ctx: unknown, opts?: RequestInit) =>
      fetch(url, opts),
  };
});

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  CourtListenerService,
  getCourtListenerService,
  initCourtListenerService,
} from '@/services/courtlistener/courtlistener-service.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMockConfig(token = 'secret-token-abc123'): AppConfig {
  return { apiToken: token } as unknown as AppConfig;
}

function makeMockStorage() {
  return {} as Parameters<typeof initCourtListenerService>[1];
}

function mockFetchResponse(
  overrides: Partial<{
    status: number;
    ok: boolean;
    headerGet: (h: string) => string | null;
    body: string;
  }> = {},
) {
  const {
    status = 200,
    ok = true,
    headerGet = () => null,
    body = '{"count":0,"next":null,"previous":null,"results":[]}',
  } = overrides;

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status,
      ok,
      headers: { get: headerGet },
      text: async () => body,
    } as unknown as Response),
  );
}

// ── init/accessor ─────────────────────────────────────────────────────────────

describe('initCourtListenerService / getCourtListenerService', () => {
  it('returns the service after initialization', () => {
    initCourtListenerService(makeMockConfig(), makeMockStorage());
    expect(() => getCourtListenerService()).not.toThrow();
    expect(getCourtListenerService()).toBeInstanceOf(CourtListenerService);
  });
});

// ── cursor extraction ────────────────────────────────────────────────────────

describe('cursor extraction from next URL', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('extracts cursor token when next URL contains cursor param', async () => {
    mockFetchResponse({
      body: JSON.stringify({
        count: 100,
        next: 'https://www.courtlistener.com/api/rest/v4/search/?cursor=cD0yMDI',
        previous: null,
        results: [],
      }),
    });
    const result = await svc.searchOpinions({ q: 'test' }, ctx);
    expect(result.nextCursor).toBe('cD0yMDI');
  });

  it('returns null nextCursor when next is null', async () => {
    mockFetchResponse({
      body: JSON.stringify({ count: 0, next: null, previous: null, results: [] }),
    });
    const result = await svc.searchOpinions({ q: 'test' }, ctx);
    expect(result.nextCursor).toBeNull();
  });

  it('returns null nextCursor when next URL has no cursor param', async () => {
    mockFetchResponse({
      body: JSON.stringify({
        count: 10,
        next: 'https://www.courtlistener.com/api/rest/v4/search/?page=2',
        previous: null,
        results: [],
      }),
    });
    const result = await svc.searchOpinions({ q: 'test' }, ctx);
    expect(result.nextCursor).toBeNull();
  });
});

// ── HTTP error classification ────────────────────────────────────────────────

describe('HTTP error classification', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(
      makeMockConfig('secret-token-should-not-leak'),
      makeMockStorage(),
    );
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws on 429 without Retry-After', async () => {
    mockFetchResponse({ status: 429, ok: false, body: '' });
    await expect(svc.searchOpinions({ q: 'test' }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('rate limit'),
    });
  });

  it('includes Retry-After in rate-limit message when header is present', async () => {
    mockFetchResponse({
      status: 429,
      ok: false,
      headerGet: (h: string) => (h === 'Retry-After' ? '60' : null),
      body: '',
    });
    await expect(svc.searchOpinions({ q: 'test' }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('60'),
    });
  });

  it('throws notFound on 404 response', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetchResponse({ status: 404, ok: false, body: '{}' });
    await expect(svc.searchOpinions({ q: 'test' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('throws serviceUnavailable when HTML body is returned on a non-200', async () => {
    mockFetchResponse({
      status: 503,
      ok: false,
      body: '<!DOCTYPE html><html><body>Service Unavailable</body></html>',
    });
    await expect(svc.searchOpinions({ q: 'test' }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('HTML'),
    });
  });

  it('throws serviceUnavailable when HTML is returned on a 200-OK response', async () => {
    mockFetchResponse({
      status: 200,
      ok: true,
      body: '<!DOCTYPE html><html><body>Maintenance</body></html>',
    });
    await expect(svc.searchOpinions({ q: 'test' }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('HTML'),
    });
  });

  it('throws serviceUnavailable on generic non-200 with JSON body', async () => {
    mockFetchResponse({
      status: 500,
      ok: false,
      body: '{"detail":"Internal Server Error"}',
    });
    await expect(svc.searchOpinions({ q: 'test' }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('500'),
    });
  });

  it('getOpinionCluster throws notFound when cluster id is missing from response', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    // First fetch: cluster; second fetch: opinions page
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        call++;
        const body =
          call === 1
            ? JSON.stringify({ id: null, sub_opinions: [] })
            : JSON.stringify({ count: 0, next: null, previous: null, results: [] });
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
      }),
    );
    await expect(svc.getOpinionCluster(99999, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('getDocket throws notFound when docket id is missing from response', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetchResponse({ body: JSON.stringify({ id: null }) });
    await expect(svc.getDocket(99999, 20, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('getPerson throws notFound when person id is missing from response', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetchResponse({ body: JSON.stringify({ id: null }) });
    await expect(svc.getPerson(99999, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });
});

// ── secret / token hygiene ────────────────────────────────────────────────────

describe('API token hygiene — token must not appear in thrown errors', () => {
  const SECRET_TOKEN = 'super-secret-api-token-abc123xyz';

  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(SECRET_TOKEN), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not expose token in rate-limit error message', async () => {
    mockFetchResponse({ status: 429, ok: false, body: '' });
    try {
      await svc.searchOpinions({ q: 'test' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain(SECRET_TOKEN);
    }
  });

  it('does not expose token in service-unavailable error message', async () => {
    mockFetchResponse({ status: 500, ok: false, body: '{"error":"server error"}' });
    try {
      await svc.searchOpinions({ q: 'test' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain(SECRET_TOKEN);
    }
  });

  it('does not expose token in 404 not-found error', async () => {
    mockFetchResponse({ status: 404, ok: false, body: '{}' });
    try {
      await svc.searchOpinions({ q: 'test' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain(SECRET_TOKEN);
    }
  });
});

// ── citation lookup POST path ────────────────────────────────────────────────

describe('lookupCitation POST path', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns structured result for a valid citation response', async () => {
    mockFetchResponse({
      body: JSON.stringify([
        {
          citation: '410 U.S. 113',
          normalized_citations: ['410 U.S. 113'],
          clusters: [
            {
              id: 100,
              caseName: 'Roe v. Wade',
              court: 'Supreme Court',
              date_filed: '1973-01-22',
              citations: [{ volume: '410', reporter: 'U.S.', page: '113' }],
            },
          ],
        },
      ]),
    });
    const result = await svc.lookupCitation('410 U.S. 113', ctx);
    expect(result.cluster_id).toBe(100);
    expect(result.case_name).toBe('Roe v. Wade');
    expect(result.normalized_citation).toBe('410 U.S. 113');
  });

  it('throws notFound when citation response is empty array', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetchResponse({ body: '[]' });
    await expect(svc.lookupCitation('999 X.Y. 999', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('throws notFound when clusters array is absent', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetchResponse({
      body: JSON.stringify([{ citation: '999 X.Y. 1', normalized_citations: [], clusters: [] }]),
    });
    await expect(svc.lookupCitation('999 X.Y. 1', ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('does not expose token in citation-lookup 429 error', async () => {
    const SECRET = 'my-secret-lookup-token';
    const svc2 = new CourtListenerService(makeMockConfig(SECRET), makeMockStorage());
    mockFetchResponse({ status: 429, ok: false, body: '' });
    try {
      await svc2.lookupCitation('410 U.S. 113', ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      expect(JSON.stringify(err)).not.toContain(SECRET);
    }
  });
});

// ── getCiting — empty opinions_cited ────────────────────────────────────────

describe('getCiting with empty opinions_cited', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns empty result when cluster has no cited opinions', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => {
        call++;
        let body: string;
        if (call === 1) {
          // cluster fetch
          body = JSON.stringify({
            id: 100,
            case_name: 'Test',
            case_name_full: '',
            court: 'SCOTUS',
            court_id: 'scotus',
            date_filed: '2020-01-01',
            docket: '/api/rest/v4/dockets/5000/',
            docket_id: 5000,
            docket_number: '20-1',
            judges: '',
            citations: [],
            citation_count: 0,
            precedential_status: 'Published',
            syllabus: '',
            posture: '',
            sub_opinions: [],
          });
        } else {
          // opinions page fetch
          body = JSON.stringify({ count: 0, next: null, previous: null, results: [] });
        }
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
      }),
    );

    const result = await svc.getCiting({ clusterId: 100 }, ctx);
    expect(result.total).toBe(0);
    expect(result.results).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
    // source case name is threaded out of the cluster fetch (snake_case from upstream)
    expect(result.sourceCaseName).toBe('Test');
  });
});

// ── rate-limit message content ────────────────────────────────────────────────

describe('rate-limit message content', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rate-limit message includes tier hint when no Retry-After', async () => {
    mockFetchResponse({ status: 429, ok: false, body: '' });
    try {
      await svc.searchOpinions({ q: 'test' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const msg = (err as Error).message ?? '';
      expect(msg).toContain('Free tier');
    }
  });

  it('rate-limit message includes Retry-After value when header present', async () => {
    mockFetchResponse({
      status: 429,
      ok: false,
      headerGet: (h: string) => (h === 'Retry-After' ? '120' : null),
      body: '',
    });
    try {
      await svc.searchOpinions({ q: 'test' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const msg = (err as Error).message ?? '';
      expect(msg).toContain('120');
    }
  });
});

// ── error contracts: reason + recovery hints (#15/#16) ───────────────────────

describe('error contracts — reason and recovery hints', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('generic 404 path sets reason: not_found in error data', async () => {
    mockFetchResponse({ status: 404, ok: false, body: '{}' });
    await expect(svc.searchOpinions({ q: 'test' }, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('getOpinionCluster not-found carries a recovery hint', async () => {
    mockFetchResponse({ body: JSON.stringify({ id: null, sub_opinions: [] }) });
    await expect(svc.getOpinionCluster(99999, ctx)).rejects.toMatchObject({
      data: {
        reason: 'not_found',
        recovery: { hint: expect.stringContaining('courtlistener_search_opinions') },
      },
    });
  });

  it('getDocket not-found carries a recovery hint', async () => {
    mockFetchResponse({ body: JSON.stringify({ id: null }) });
    await expect(svc.getDocket(99999, 20, ctx)).rejects.toMatchObject({
      data: {
        reason: 'not_found',
        recovery: { hint: expect.stringContaining('courtlistener_search_dockets') },
      },
    });
  });

  it('getPerson not-found carries a recovery hint', async () => {
    mockFetchResponse({ body: JSON.stringify({ id: null }) });
    await expect(svc.getPerson(99999, ctx)).rejects.toMatchObject({
      data: {
        reason: 'not_found',
        recovery: { hint: expect.stringContaining('courtlistener_search_judges') },
      },
    });
  });
});

// ── getDocketSummary / getClusterCaseName (#9, #18) ──────────────────────────

describe('getDocketSummary and getClusterCaseName', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getDocketSummary returns court_id, docket_number, and case_name', async () => {
    mockFetchResponse({
      body: JSON.stringify({
        id: 5000,
        court_id: 'scotus',
        docket_number: '70-18',
        case_name: 'Roe v. Wade',
      }),
    });
    const result = await svc.getDocketSummary(5000, ctx);
    expect(result).toEqual({
      court_id: 'scotus',
      docket_number: '70-18',
      case_name: 'Roe v. Wade',
    });
  });

  it('getClusterCaseName returns the cluster case_name', async () => {
    mockFetchResponse({ body: JSON.stringify({ id: 100, case_name: 'Miranda v. Arizona' }) });
    expect(await svc.getClusterCaseName(100, ctx)).toBe('Miranda v. Arizona');
  });

  it('getClusterCaseName returns null when case_name is absent', async () => {
    mockFetchResponse({ body: JSON.stringify({ id: 100 }) });
    expect(await svc.getClusterCaseName(100, ctx)).toBeNull();
  });
});

// ── financial disclosures and oral argument detail (#12) ─────────────────────

describe('searchFinancialDisclosures', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns disclosures and a null total when count is a URL string', async () => {
    mockFetchResponse({
      body: JSON.stringify({
        count: 'https://www.courtlistener.com/api/rest/v4/financial-disclosures/?count=on',
        next: null,
        previous: null,
        results: [{ id: 1, person: '/people/3045/', year: 2022, report_type: 2 }],
      }),
    });
    const result = await svc.searchFinancialDisclosures({ person: 3045 }, ctx);
    expect(result.total).toBeNull();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe(1);
  });

  it('reports a numeric total when the API provides one', async () => {
    mockFetchResponse({
      body: JSON.stringify({ count: 5, next: null, previous: null, results: [] }),
    });
    const result = await svc.searchFinancialDisclosures({ person: 3045 }, ctx);
    expect(result.total).toBe(5);
  });
});

// ── fetchWithTimeout non-2xx interception (production error path) ─────────────
// In production fetchWithTimeout THROWS an McpError on non-2xx (with data.statusCode,
// no data.reason, leaking the URL) before the manual status checks run. These tests
// drive that path by rejecting the underlying fetch, asserting the classifier remaps it.

describe('fetchWithTimeout non-2xx interception', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('remaps a thrown 404 to notFound with reason + recovery and no leaked URL', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          new McpError(
            JsonRpcErrorCode.NotFound,
            'Fetch failed for https://www.courtlistener.com/api/rest/v4/clusters/999/. Status: 404',
            { statusCode: 404, errorSource: 'FetchHttpError' },
          ),
        ),
    );
    try {
      await svc.getOpinionCluster(999, ctx);
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as { code: number; message: string; data: Record<string, unknown> };
      expect(e.code).toBe(JsonRpcErrorCode.NotFound);
      expect(e.data.reason).toBe('not_found');
      expect((e.data.recovery as { hint: string }).hint).toContain('courtlistener_search_opinions');
      // the upstream URL must not leak through into the remapped message
      expect(e.message).not.toContain('https://');
    }
  });

  it('remaps a thrown 429 to rateLimited with reason', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(
        new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', {
          statusCode: 429,
          errorSource: 'FetchHttpError',
        }),
      ),
    );
    await expect(svc.searchOpinions({ q: 'test' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited' },
    });
  });
});

describe('getOralArgument', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the audio record', async () => {
    mockFetchResponse({
      body: JSON.stringify({
        id: 105162,
        case_name: 'Test Argument',
        duration: 1607,
        stt_transcript: 'transcript text',
        panel: [42],
      }),
    });
    const result = await svc.getOralArgument(105162, ctx);
    expect(result.id).toBe(105162);
    expect(result.stt_transcript).toBe('transcript text');
  });

  it('throws not_found with a recovery hint when the audio id is missing', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetchResponse({ body: JSON.stringify({ id: null }) });
    await expect(svc.getOralArgument(99999, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'not_found',
        recovery: { hint: expect.stringContaining('courtlistener_search_oral_arguments') },
      },
    });
  });
});
