/**
 * @fileoverview Tests for the CourtListener service — error classification,
 * pagination cursor extraction, token/secret hygiene, and network-failure paths.
 * All tests mock `withRetry` and `fetchWithTimeout` to avoid network calls and
 * retry delays.
 * @module tests/service/courtlistener-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock withRetry to execute the fn directly (no retries, no backoff) and fetchWithTimeout
// to delegate to the mocked global fetch — throwing on non-2xx exactly as the real transport
// does, so the service's classifyFetchError path is the one under test. (A mock that returned
// the raw Response on an error status routed every non-2xx case into the service's manual
// fallback branches, which production never reaches.)
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
  return {
    ...original,
    withRetry: async (fn: () => Promise<unknown>) => fn(),
    fetchWithTimeout: async (url: string, _timeout: number, _ctx: unknown, opts?: RequestInit) => {
      const response = await fetch(url, opts);
      if (response.ok) return response;
      const body = await response.text().catch(() => '');
      const retryAfter = response.headers.get('retry-after');
      throw new McpError(
        original.httpStatusToErrorCode(response.status) ?? JsonRpcErrorCode.InternalError,
        `Fetch failed for ${url}. Status: ${response.status}`,
        {
          status: response.status,
          statusText: response.statusText,
          body,
          ...(retryAfter !== null && { retryAfter }),
          errorSource: 'FetchHttpError',
        },
      );
    },
  };
});

import { getDocketTool } from '@/mcp-server/tools/definitions/get-docket.tool.js';
import { getPartiesTool } from '@/mcp-server/tools/definitions/get-parties.tool.js';
import {
  CourtListenerService,
  type CourtListenerServiceConfig,
  getCourtListenerService,
  initCourtListenerService,
} from '@/services/courtlistener/courtlistener-service.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeMockConfig(token = 'secret-token-abc123'): CourtListenerServiceConfig {
  return { apiToken: token, mcpServerVersion: '0.0.0-test' };
}

function makeMockStorage() {
  return {} as Parameters<typeof initCourtListenerService>[1];
}

function mockFetchResponse(
  overrides: Partial<{
    status: number;
    ok: boolean;
    headers: Record<string, string>;
    body: string;
  }> = {},
) {
  const {
    status = 200,
    ok = true,
    headers = {},
    body = '{"count":0,"next":null,"previous":null,"results":[]}',
  } = overrides;

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status,
      ok,
      // A real Headers instance — header lookup is case-insensitive upstream, and the
      // transport reads `retry-after` lowercase.
      headers: new Headers(headers),
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

// ── outbound request headers ─────────────────────────────────────────────────

describe('outbound headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('derives the User-Agent version from the server config, not a literal (#55)', async () => {
    const svc = new CourtListenerService(
      { apiToken: 'tok', mcpServerVersion: '9.8.7' },
      makeMockStorage(),
    );
    mockFetchResponse();

    await svc.searchOpinions({ q: 'test' }, createMockContext());

    const init = vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(
      'courtlistener-mcp-server/9.8.7',
    );
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
    mockFetchResponse({ status: 429, ok: false, headers: { 'Retry-After': '60' }, body: '' });
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

  it('surfaces a 503 HTML error page as ServiceUnavailable', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetchResponse({
      status: 503,
      ok: false,
      body: '<!DOCTYPE html><html><body>Service Unavailable</body></html>',
    });
    // The transport maps the status and throws before the service sees the body, so the
    // classifier passes a 503 through with its status-mapped code.
    await expect(svc.searchOpinions({ q: 'test' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { status: 503 },
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
    await expect(svc.getDocket(99999, 20, 1, ctx)).rejects.toMatchObject({
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

  it('rate-limit message names the throttle windows when no Retry-After', async () => {
    mockFetchResponse({ status: 429, ok: false, body: '' });
    try {
      await svc.searchOpinions({ q: 'test' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const msg = (err as Error).message ?? '';
      expect(msg).toContain('per minute, hour, and day');
      // No per-tier request ceiling is asserted — the published figures are unconfirmed,
      // and the actionable wait is the Retry-After the error already carries.
      expect(msg).not.toMatch(/\d+\s*(req)?\/(min|hr|day)/);
    }
  });

  it('rate-limit message includes Retry-After value when header present', async () => {
    mockFetchResponse({ status: 429, ok: false, headers: { 'Retry-After': '120' }, body: '' });
    try {
      await svc.searchOpinions({ q: 'test' }, ctx);
      expect.fail('Should have thrown');
    } catch (err) {
      const msg = (err as Error).message ?? '';
      expect(msg).toContain('120');
    }
  });

  it('forwards the upstream Retry-After onto the error data, not just the message (#52)', async () => {
    mockFetchResponse({ status: 429, ok: false, headers: { 'Retry-After': '47' }, body: '' });
    await expect(svc.searchOpinions({ q: 'test' }, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('Retry-After: 47s'),
      data: { reason: 'rate_limited', retryable: false, retryAfter: '47' },
    });
  });

  it('omits retryAfter when CourtListener sends no Retry-After header (#52)', async () => {
    mockFetchResponse({ status: 429, ok: false, body: '' });
    const err = (await svc.searchOpinions({ q: 'test' }, ctx).catch((e) => e)) as {
      data: Record<string, unknown>;
    };
    expect(err.data.reason).toBe('rate_limited');
    expect(err.data).not.toHaveProperty('retryAfter');
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
    await expect(svc.getDocket(99999, 20, 1, ctx)).rejects.toMatchObject({
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

// ── getDocketSummary (#9, #18) ───────────────────────────────────────────────

describe('getDocketSummary', () => {
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

describe('getFinancialDisclosure', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A recorded slice of the live /financial-disclosures/34207/ payload (person 3045,
  // 2022). Categories arrive inline as arrays of rows carrying resource_uri,
  // timestamps, and a financial_disclosure back-reference — noise the tool ignores.
  // Kept here so a change to the raw upstream shape surfaces in the service test.
  const RECORDED_34207 = {
    resource_uri: 'https://www.courtlistener.com/api/rest/v4/financial-disclosures/34207/',
    id: 34207,
    person: 'https://www.courtlistener.com/api/rest/v4/people/3045/',
    year: 2022,
    report_type: 2,
    page_count: 12,
    is_amended: false,
    has_been_extracted: true,
    filepath: 'https://storage.courtlistener.com/us/federal/.../3045-disclosure.2022.pdf',
    thumbnail: null,
    sha1: 'abc123',
    gifts: [],
    agreements: [],
    spouse_incomes: [],
    investments: [
      {
        resource_uri: 'https://www.courtlistener.com/api/rest/v4/investments/5385757/',
        id: 5385757,
        date_created: '2023-08-31T08:48:07.096436-07:00',
        page_number: 5,
        description: 'Citibank, N.A. Accounts',
        redacted: false,
        income_during_reporting_period_code: 'A',
        income_during_reporting_period_type: 'Interest',
        gross_value_code: 'N',
        gross_value_method: 'T',
        transaction_during_reporting_period: '',
        transaction_date_raw: '',
        transaction_value_code: '',
        transaction_gain_code: '',
        transaction_partner: '',
        has_inferred_values: false,
        financial_disclosure:
          'https://www.courtlistener.com/api/rest/v4/financial-disclosures/34207/',
      },
    ],
    debts: [
      {
        resource_uri: 'https://www.courtlistener.com/api/rest/v4/debts/53678/',
        id: 53678,
        creditor_name: 'Wells Fargo Bank, NA',
        description: 'Mortgage on Rental Property #1',
        value_code: 'N',
        redacted: false,
      },
    ],
    positions: [
      {
        resource_uri: 'https://www.courtlistener.com/api/rest/v3/disclosure-positions/99105/',
        id: 99105,
        position: 'Governing Director',
        organization_name: 'iCivics',
        redacted: false,
      },
    ],
    reimbursements: [
      {
        resource_uri: 'https://www.courtlistener.com/api/rest/v4/reimbursements/97031/',
        id: 97031,
        source: 'Washington University in St. Louis',
        date_raw: 'April 3-5, 2022',
        location: 'St Louis, MO',
        purpose: 'Meeting with students, meeting with local judges',
        items_paid_or_provided: 'Transportation, Lodging and Meals',
        redacted: false,
      },
    ],
    non_investment_incomes: [
      {
        resource_uri: 'https://www.courtlistener.com/api/rest/v4/non-investment-incomes/42529/',
        id: 42529,
        date_raw: '3/10/2022',
        source_type: 'DHX Media Ltd. (second option fee)',
        income_amount: '$10,116.00',
        redacted: false,
      },
    ],
  };

  it('returns the disclosure with every category inlined in one call (#34)', async () => {
    mockFetchResponse({ body: JSON.stringify(RECORDED_34207) });
    const result = await svc.getFinancialDisclosure(34207, ctx);

    expect(result.id).toBe(34207);
    expect(result.year).toBe(2022);
    // categories are inline arrays — the detail endpoint returns them in one call
    expect(result.investments).toHaveLength(1);
    expect(result.investments[0].description).toBe('Citibank, N.A. Accounts');
    expect(result.investments[0].gross_value_code).toBe('N');
    expect(result.debts[0].value_code).toBe('N');
    expect(result.positions[0].organization_name).toBe('iCivics');
    expect(result.non_investment_incomes[0].income_amount).toBe('$10,116.00');
  });

  it('throws not_found with a recovery hint when the disclosure id is missing', async () => {
    const { JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockFetchResponse({ body: JSON.stringify({ id: null }) });
    await expect(svc.getFinancialDisclosure(99999, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'not_found',
        recovery: { hint: expect.stringContaining('courtlistener_search_financial_disclosures') },
      },
    });
  });

  it('drives the recorded payload through the tool to schema-valid decoded output (#34)', async () => {
    const { getFinancialDisclosureTool } = await import(
      '@/mcp-server/tools/definitions/get-financial-disclosure.tool.js'
    );
    initCourtListenerService(makeMockConfig(), makeMockStorage());
    mockFetchResponse({ body: JSON.stringify(RECORDED_34207) });

    const input = getFinancialDisclosureTool.input.parse({
      disclosure_id: 34207,
      categories: ['investments', 'debts'],
    });
    const result = await getFinancialDisclosureTool.handler(input, ctx);

    // Raw coded columns decode to readable ranges through the real handler.
    expect(() => getFinancialDisclosureTool.output.parse(result)).not.toThrow();
    expect(result.investments?.[0]?.value_range).toBe('$250,001 - $500,000');
    expect(result.investments?.[0]?.income_range).toBe('$1 - $1,000');
    expect(result.debts?.[0]?.value_range).toBe('$250,001 - $500,000');
    expect(result.person_id).toBe(3045);
  });
});

// ── fetchWithTimeout non-2xx interception (production error path) ─────────────
// In production fetchWithTimeout THROWS an McpError on non-2xx (with data.status,
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
            { status: 404, errorSource: 'FetchHttpError' },
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
          status: 429,
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

// ── getOpinionCluster sub-opinion pagination (#48) ───────────────────────────
// /clusters/{id}/ serves sub_opinions as URI strings, so the variants come from a
// separate cursor-paginated /opinions/ call. The bug took the first page and dropped the
// rest, shortening the retrievable-variant outline and both citation directions' ID lists
// with nothing on the response to say so.

describe('getOpinionCluster sub-opinion pagination (#48)', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Stub a cluster whose /opinions/ list holds `total` variants served `perPage` at a
   * time over a cursor. Every variant cites one distinct opinion, so the cited-ID list
   * behind `citing` grows with the variants reached. Returns the /opinions/ URLs called.
   */
  function stubCluster(total: number, perPage: number): string[] {
    const opinionUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        let body: string;
        if (url.includes('/opinions/')) {
          opinionUrls.push(url);
          const offset = Number(new URL(url).searchParams.get('cursor') ?? 0);
          const rows = Math.max(0, Math.min(perPage, total - offset));
          body = JSON.stringify({
            count: total,
            next:
              offset + perPage < total
                ? `https://www.courtlistener.com/api/rest/v4/opinions/?cursor=${offset + perPage}`
                : null,
            previous: null,
            results: Array.from({ length: rows }, (_, i) => ({
              id: 9_000_000 + offset + i,
              type: '020lead',
              opinions_cited: [
                `https://www.courtlistener.com/api/rest/v4/opinions/${500_000 + offset + i}/`,
              ],
            })),
          });
        } else if (url.includes('/search/')) {
          body = JSON.stringify({ count: 0, next: null, previous: null, results: [] });
        } else {
          body = JSON.stringify({ id: 108713, case_name: 'Source Case', sub_opinions: [] });
        }
        return { status: 200, ok: true, headers: new Headers(), text: async () => body };
      }),
    );
    return opinionUrls;
  }

  it('walks the cursor to the end instead of keeping only the first page', async () => {
    const opinionUrls = stubCluster(35, 20);

    const cluster = await svc.getOpinionCluster(108713, ctx);

    expect(cluster.sub_opinions).toHaveLength(35);
    expect(opinionUrls).toHaveLength(2);
    // The continuation carries the cursor token off the first page's `next`.
    expect(new URL(opinionUrls[0]).searchParams.get('cursor')).toBeNull();
    expect(new URL(opinionUrls[1]).searchParams.get('cursor')).toBe('20');
  });

  it('costs a single call for a cluster that fits on one page', async () => {
    const opinionUrls = stubCluster(3, 20);

    const cluster = await svc.getOpinionCluster(108713, ctx);

    expect(cluster.sub_opinions).toHaveLength(3);
    expect(opinionUrls).toHaveLength(1);
  });

  it('warns instead of silently truncating when the page bound is hit', async () => {
    const opinionUrls = stubCluster(400, 20);

    const cluster = await svc.getOpinionCluster(108713, ctx);

    expect(opinionUrls).toHaveLength(5);
    expect(cluster.sub_opinions).toHaveLength(100);
    expect(ctx.log.calls).toContainEqual(
      expect.objectContaining({
        level: 'warning',
        data: expect.objectContaining({ clusterId: 108713, fetched: 100 }),
      }),
    );
  });

  it('feeds the citing direction every variant, not just the first page', async () => {
    stubCluster(35, 20);

    const result = await svc.getCiting({ clusterId: 108713, page_size: 100 }, ctx);

    // One distinct cited opinion per variant — capped at 20 before the walk landed.
    expect(result.total).toBe(35);
  });
});

// ── getCitedBy queries the cites index by opinion ID (#58) ───────────────────
// `/search/?type=o`'s `cites` field is keyed by opinion ID. Querying it with a cluster ID
// matched only where the two coincide (common in legacy single-opinion imports), and
// returned an empty network — indistinguishable from a genuinely uncited case — otherwise.

describe('getCitedBy queries the cites index by opinion ID (#58)', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Stub cluster 8588094 holding the given opinion IDs, served `perPage` at a time —
   * the live case where the cluster ID and its opinion ID diverge. Returns the /search/
   * URLs called, so the built `q` can be asserted.
   */
  function stubCluster(opinionIds: number[], perPage = 20, searchNext: string | null = null) {
    const searchUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        let body: string;
        if (url.includes('/search/')) {
          searchUrls.push(url);
          body = JSON.stringify({
            count: 339,
            next: searchNext,
            previous: null,
            results: [{ cluster_id: 4242, caseName: 'Citing Case', opinions: [] }],
          });
        } else if (url.includes('/opinions/')) {
          const offset = Number(new URL(url).searchParams.get('cursor') ?? 0);
          body = JSON.stringify({
            count: opinionIds.length,
            next:
              offset + perPage < opinionIds.length
                ? `https://www.courtlistener.com/api/rest/v4/opinions/?cursor=${offset + perPage}`
                : null,
            previous: null,
            results: opinionIds
              .slice(offset, offset + perPage)
              .map((id) => ({ id, type: '020lead' })),
          });
        } else {
          body = JSON.stringify({ id: 8588094, case_name: 'Source Case', sub_opinions: [] });
        }
        return { status: 200, ok: true, headers: new Headers(), text: async () => body };
      }),
    );
    return searchUrls;
  }

  it('queries the opinion ID, never the cluster ID', async () => {
    const searchUrls = stubCluster([8562940]);

    const result = await svc.getCitedBy({ clusterId: 8588094 }, ctx);

    const q = new URL(searchUrls[0]).searchParams.get('q');
    expect(q).toBe('cites:(8562940)');
    expect(q).not.toContain('8588094');
    expect(result.total).toBe(339);
    expect(result.results).toHaveLength(1);
  });

  it('ORs every opinion variant of the cluster into one query', async () => {
    const searchUrls = stubCluster([8562940, 8562941, 8562942]);

    await svc.getCitedBy({ clusterId: 8588094 }, ctx);

    expect(new URL(searchUrls[0]).searchParams.get('q')).toBe(
      'cites:(8562940) OR cites:(8562941) OR cites:(8562942)',
    );
  });

  it('includes variants past the first page of /opinions/ (#48)', async () => {
    const searchUrls = stubCluster([8562940, 8562941, 8562942], 2);

    await svc.getCitedBy({ clusterId: 8588094 }, ctx);

    // The third variant lives on the second cursor page — dropping it would ship a
    // confidently incomplete citation network.
    expect(new URL(searchUrls[0]).searchParams.get('q')).toContain('cites:(8562942)');
  });

  it('returns the source case name from the same fetch that resolved the IDs', async () => {
    stubCluster([8562940]);

    const result = await svc.getCitedBy({ clusterId: 8588094 }, ctx);

    // No second /clusters/ call just to name the source — three upstream calls, not four.
    expect(result.sourceCaseName).toBe('Source Case');
    expect(vi.mocked(fetch).mock.calls).toHaveLength(3);
  });

  it('short-circuits without a search when the cluster has no opinion variants', async () => {
    const searchUrls = stubCluster([]);

    const result = await svc.getCitedBy({ clusterId: 8588094 }, ctx);

    expect(searchUrls).toEqual([]);
    expect(result).toMatchObject({ total: 0, results: [], nextCursor: null });
  });

  it('passes filters through and keeps paging on the upstream cursor', async () => {
    const searchUrls = stubCluster(
      [8562940],
      20,
      'https://www.courtlistener.com/api/rest/v4/search/?cursor=cD0yMDI',
    );

    const result = await svc.getCitedBy(
      { clusterId: 8588094, court: 'scotus', filed_after: '2010-01-01', cursor: 'cD0xMDA' },
      ctx,
    );

    const params = new URL(searchUrls[0]).searchParams;
    expect(params.get('court')).toBe('scotus');
    expect(params.get('filed_after')).toBe('2010-01-01');
    expect(params.get('cursor')).toBe('cD0xMDA');
    // Upstream's own cursor drives the pages, so count, filters, and pages agree.
    expect(result.nextCursor).toBe('cD0yMDI');
  });
});

// ── getCiting cursor pagination (#24) ────────────────────────────────────────
// getCiting holds the full cited-ID list in memory; the cursor is an offset into it.
// The bug ignored the cursor and re-sliced from index 0, returning page 1 forever.

describe('getCiting cursor pagination (#24)', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('advances to a different page when the cursor is passed', async () => {
    const searchUrls: string[] = [];
    const citedUris = [101, 102, 103, 104, 105].map(
      (n) => `https://www.courtlistener.com/api/rest/v4/opinions/${n}/`,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        let body: string;
        if (url.includes('/clusters/')) {
          body = JSON.stringify({ id: 100, case_name: 'Source Opinion', sub_opinions: [] });
        } else if (url.includes('/opinions/')) {
          // sub_opinions for the cluster — these carry the opinions_cited URIs.
          body = JSON.stringify({
            count: 1,
            next: null,
            previous: null,
            results: [{ id: 9, opinions_cited: citedUris }],
          });
        } else if (url.includes('/search/')) {
          searchUrls.push(url);
          body = JSON.stringify({ count: 0, next: null, previous: null, results: [] });
        } else {
          body = JSON.stringify({ count: 0, next: null, previous: null, results: [] });
        }
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
      }),
    );

    const page1 = await svc.getCiting({ clusterId: 100, page_size: 2 }, ctx);
    const page2 = await svc.getCiting({ clusterId: 100, page_size: 2, cursor: '2' }, ctx);

    // Page boundaries advance by page_size (offset 0 → 2 → 4) over 5 cited IDs.
    expect(page1.nextCursor).toBe('2');
    expect(page2.nextCursor).toBe('4');

    // The cursored page queries DIFFERENT cited IDs — not the first page again.
    const q1 = new URL(searchUrls[0]).searchParams.get('q') ?? '';
    const q2 = new URL(searchUrls[1]).searchParams.get('q') ?? '';
    expect(q1).toContain('id:(101)');
    expect(q1).toContain('id:(102)');
    expect(q1).not.toContain('id:(103)');
    expect(q2).toContain('id:(103)');
    expect(q2).toContain('id:(104)');
    expect(q2).not.toContain('id:(101)');
  });
});

// ── getCiting filters vs. total and cursor (#56) ─────────────────────────────
// `citing` slices the cited-opinion list client-side and lets upstream apply the filters
// to each page, so `total` counts unfiltered opinions while `results` are filtered
// clusters. The units and the filter status are documented on the tool rather than
// reconciled here; a filter-emptied page keeps its continuation cursor so the remaining
// pages stay reachable.

describe('getCiting filters vs. total and cursor (#56)', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the filters upstream while total and cursor track the unfiltered ID list', async () => {
    const searchUrls: string[] = [];
    const citedUris = [101, 102, 103, 104, 105].map(
      (n) => `https://www.courtlistener.com/api/rest/v4/opinions/${n}/`,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        let body: string;
        if (url.includes('/search/')) {
          searchUrls.push(url);
          // The court filter excludes both cited opinions on this page.
          body = JSON.stringify({ count: 0, next: null, previous: null, results: [] });
        } else if (url.includes('/opinions/')) {
          body = JSON.stringify({
            count: 1,
            next: null,
            previous: null,
            results: [{ id: 9, opinions_cited: citedUris }],
          });
        } else {
          body = JSON.stringify({ id: 100, case_name: 'Source Opinion', sub_opinions: [] });
        }
        return { status: 200, ok: true, headers: new Headers(), text: async () => body };
      }),
    );

    const page = await svc.getCiting(
      { clusterId: 100, page_size: 2, court: 'scotus', filed_after: '2010-01-01' },
      ctx,
    );

    const params = new URL(searchUrls[0]).searchParams;
    expect(params.get('court')).toBe('scotus');
    expect(params.get('filed_after')).toBe('2010-01-01');
    // Filtered out on this page, but three cited opinions remain to check.
    expect(page.results).toHaveLength(0);
    expect(page.nextCursor).toBe('2');
    // Counts cited opinions before filtering — the semantics totalCount now states.
    expect(page.total).toBe(5);
  });
});

// ── getDocket entries pagination (#32) ───────────────────────────────────────
// /docket-entries/ is page-paginated: entriesPage must reach the upstream `page` param,
// and a non-null upstream `next` (a ...&page=N URL, not a cursor token) must surface as a
// stringified next-page number on the docket.

describe('getDocket entries pagination (#32)', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('threads entriesPage into the upstream page param and surfaces the next page', async () => {
    const entryUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        let body: string;
        if (url.includes('/docket-entries/')) {
          entryUrls.push(url);
          body = JSON.stringify({
            count: 153,
            next: 'https://www.courtlistener.com/api/rest/v4/docket-entries/?docket=5578727&page=3',
            previous: null,
            results: [
              {
                id: 60021,
                entry_number: 21,
                date_filed: '2020-02-01',
                description: 'Order',
                recap_documents: [],
              },
            ],
          });
        } else {
          body = JSON.stringify({ id: 5578727, case_name: 'X', court_id: 'nysd' });
        }
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
      }),
    );

    const docket = await svc.getDocket(5578727, 20, 2, ctx);

    // entriesPage (2) reaches the upstream `page` query param — not hardcoded to page 1.
    const entryUrl = new URL(entryUrls[0]);
    expect(entryUrl.searchParams.get('page')).toBe('2');
    expect(entryUrl.searchParams.get('docket')).toBe('5578727');
    // A non-null upstream `next` surfaces as the stringified next page number (2 → "3").
    expect(docket.docket_entries_next_page).toBe('3');
    expect(docket.docket_entries_count).toBe(153);
  });

  it('surfaces a null next page when upstream reports no more entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        const body = url.includes('/docket-entries/')
          ? JSON.stringify({ count: 5, next: null, previous: null, results: [] })
          : JSON.stringify({ id: 5578727, case_name: 'X', court_id: 'nysd' });
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
      }),
    );
    const docket = await svc.getDocket(5578727, 20, 1, ctx);
    expect(docket.docket_entries_next_page).toBeNull();
  });
});

// ── getParties: docket scoping, attorney detail, role decoding (#45 #54 #59) ──
// A /parties/ record carries the party's attorney relationships for EVERY docket that
// party has ever appeared on. Batching all of them into /attorneys/?id=… overran the
// origin's URI limit (414) and reported unrelated counsel as attorneys on this docket —
// and `id` is an exact lookup, so the batch resolved detail for only one of them.

describe('getParties attorney scoping, detail, and role decoding (#45 #54 #59)', () => {
  const DOCKET = 4192313;
  const OTHER_DOCKET = 4219807;

  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stub /parties/ with the given relationships; records every /attorneys/ URL requested. */
  function stubParties(
    attorneys: Array<{
      attorney_id: number;
      docket_id: number;
      role: number | null;
      date_action: string | null;
    }>,
    details: Array<{ id: number; name: string }> = [],
  ): string[] {
    const attorneyUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        let body: string;
        if (url.includes('/attorneys/')) {
          attorneyUrls.push(url);
          const params = new URL(url).searchParams;
          const expand = (rows: typeof details) =>
            rows.map((d) => ({
              ...d,
              contact_raw: `${d.name} — 865 S Figueroa St`,
              email: '',
              fax: '',
              phone: '',
            }));
          // `id` is an exact lookup upstream: repeated params collapse to the LAST value, so a
          // multi-ID request resolves exactly one record (#59). Modelled here so a return to
          // ID batching fails loudly instead of passing against a forgiving stub.
          const ids = params.getAll('id');
          if (ids.length > 0) {
            const last = Number(ids[ids.length - 1]);
            body = JSON.stringify({
              count: 1,
              next: null,
              previous: null,
              results: expand(details.filter((d) => d.id === last)),
            });
          } else {
            // The docket filter returns the docket's whole roster, cursor-paginated.
            const offset = Number(params.get('cursor') ?? 0);
            const nextOffset = offset + 100;
            body = JSON.stringify({
              count: details.length,
              next:
                nextOffset < details.length
                  ? `https://www.courtlistener.com/api/rest/v4/attorneys/?cursor=${nextOffset}`
                  : null,
              previous: null,
              results: expand(details.slice(offset, nextOffset)),
            });
          }
        } else {
          body = JSON.stringify({
            count: 'https://www.courtlistener.com/api/rest/v4/parties/?count=on',
            next: null,
            previous: null,
            results: [
              {
                id: 2001,
                name: 'Apple Inc.',
                extra_info: '',
                party_types: [
                  {
                    docket: `https://www.courtlistener.com/api/rest/v4/dockets/${DOCKET}/`,
                    name: 'Defendant',
                  },
                  {
                    docket: `https://www.courtlistener.com/api/rest/v4/dockets/${OTHER_DOCKET}/`,
                    name: 'Plaintiff',
                  },
                ],
                attorneys,
              },
            ],
          });
        }
        return { status: 200, ok: true, headers: new Headers(), text: async () => body };
      }),
    );
    return attorneyUrls;
  }

  it('keeps only the relationships belonging to the requested docket', async () => {
    const attorneyUrls = stubParties(
      [
        { attorney_id: 106656, docket_id: DOCKET, role: 2, date_action: null },
        { attorney_id: 999001, docket_id: OTHER_DOCKET, role: 1, date_action: null },
        { attorney_id: 999002, docket_id: 5_000_000, role: 1, date_action: null },
      ],
      [{ id: 106656, name: 'Sidford L Brown' }],
    );

    const result = await svc.getParties(DOCKET, 1, 10, ctx);

    expect(result.parties[0]?.attorneys.map((a) => a.attorney_id)).toEqual([106656]);
    // Detail is resolved through the docket filter — `id` is an exact lookup upstream, so a
    // repeated-`id` batch silently resolved only the last one (#59).
    const attorneyUrl = new URL(attorneyUrls[0] ?? '');
    expect(attorneyUrl.searchParams.get('docket')).toBe(String(DOCKET));
    expect(attorneyUrl.searchParams.getAll('id')).toEqual([]);
  });

  it('resolves a name and contact block for every attorney on the docket (#59)', async () => {
    const attorneyUrls = stubParties(
      [
        { attorney_id: 106656, docket_id: DOCKET, role: 2, date_action: null },
        { attorney_id: 663414, docket_id: DOCKET, role: 1, date_action: null },
        { attorney_id: 106657, docket_id: DOCKET, role: 1, date_action: null },
      ],
      [
        { id: 106656, name: 'Sidford L Brown' },
        { id: 663414, name: 'Bruce R Zisser' },
        { id: 106657, name: 'Lara Sue Garner' },
      ],
    );

    const attorneys = (await svc.getParties(DOCKET, 1, 10, ctx)).parties[0]?.attorneys ?? [];

    expect(attorneys.map((a) => a.name)).toEqual([
      'Sidford L Brown',
      'Bruce R Zisser',
      'Lara Sue Garner',
    ]);
    for (const att of attorneys) expect(att.contact_raw).not.toBe('');
    // One upstream call for the whole roster — no per-attorney fan-out.
    expect(attorneyUrls).toHaveLength(1);
  });

  it('makes no attorney request when the page has no attorneys of record', async () => {
    const attorneyUrls = stubParties([
      { attorney_id: 999001, docket_id: OTHER_DOCKET, role: 1, date_action: null },
    ]);

    const result = await svc.getParties(DOCKET, 1, 10, ctx);

    expect(result.parties[0]?.attorneys).toEqual([]);
    expect(attorneyUrls).toEqual([]);
  });

  it('decodes role_code to a label and carries the end date of a terminated relationship', async () => {
    stubParties(
      [
        { attorney_id: 106656, docket_id: DOCKET, role: 2, date_action: null },
        { attorney_id: 106657, docket_id: DOCKET, role: 6, date_action: '2013-11-04' },
        { attorney_id: 106658, docket_id: DOCKET, role: 99, date_action: null },
      ],
      [
        { id: 106656, name: 'Sidford L Brown' },
        { id: 106657, name: 'Lara Sue Garner' },
        { id: 106658, name: 'Unlisted Counsel' },
      ],
    );

    const attorneys = (await svc.getParties(DOCKET, 1, 10, ctx)).parties[0]?.attorneys ?? [];

    // 2 is "Lead attorney" — 1 is "Attorney to be noticed", the mapping the docs had backwards.
    expect(attorneys[0]).toMatchObject({ role_code: 2, role: 'Lead attorney', date_action: null });
    expect(attorneys[1]).toMatchObject({ role: 'Terminated', date_action: '2013-11-04' });
    // Codes outside the documented enum pass through as the stringified code.
    expect(attorneys[2]).toMatchObject({ role_code: 99, role: '99' });
  });

  it('walks cursor pages until every attorney on a large roster is resolved', async () => {
    const attorneys = Array.from({ length: 250 }, (_, i) => ({
      attorney_id: 200_000 + i,
      docket_id: DOCKET,
      role: 1,
      date_action: null,
    }));
    const details = attorneys.map((a) => ({
      id: a.attorney_id,
      name: `Counsel ${a.attorney_id}`,
    }));
    const attorneyUrls = stubParties(attorneys, details);

    const resolved = (await svc.getParties(DOCKET, 1, 10, ctx)).parties[0]?.attorneys ?? [];

    expect(resolved).toHaveLength(250);
    expect(resolved.every((a) => a.name !== '')).toBe(true);
    // 250 rows at 100 per page — three cursor pages, then the walk stops.
    expect(attorneyUrls).toHaveLength(3);
  });

  it('warns instead of silently emitting blank names when the page bound is hit', async () => {
    const attorneys = Array.from({ length: 600 }, (_, i) => ({
      attorney_id: 300_000 + i,
      docket_id: DOCKET,
      role: 1,
      date_action: null,
    }));
    const details = attorneys.map((a) => ({ id: a.attorney_id, name: `Counsel ${a.attorney_id}` }));
    const attorneyUrls = stubParties(attorneys, details);

    const resolved = (await svc.getParties(DOCKET, 1, 10, ctx)).parties[0]?.attorneys ?? [];

    // The walk stops at the bound, so the tail keeps empty names — but it is announced.
    expect(attorneyUrls).toHaveLength(5);
    expect(resolved.filter((a) => a.name === '')).toHaveLength(100);
    expect(ctx.log.calls).toContainEqual(
      expect.objectContaining({
        level: 'warning',
        data: expect.objectContaining({ docketId: DOCKET, unresolved: 100 }),
      }),
    );
  });

  it('reports an absent upstream role code as Unrecorded rather than a fabricated label', async () => {
    stubParties(
      [{ attorney_id: 106656, docket_id: DOCKET, role: null, date_action: null }],
      [{ id: 106656, name: 'Sidford L Brown' }],
    );

    const attorneys = (await svc.getParties(DOCKET, 1, 10, ctx)).parties[0]?.attorneys ?? [];

    // CourtListener's Role.role is nullable; String(null) would have shipped "null" as a label.
    expect(attorneys[0]).toMatchObject({ role_code: null, role: 'Unrecorded' });
  });
});

// ── raw upstream payloads → tool output schema (regression: #22 #23 #26) ──────
// The pre-existing tool tests mock the SERVICE with already-normalized values, so the
// real /parties/ and /docket-entries/ shapes (URL-string counts, string document_number,
// relative filepath_local) were never validated — that gap let these bugs ship. These
// drive the RAW upstream shapes through the real service + tool handler and assert the
// declared output schema parses.

describe('raw upstream payloads validate through the tool output schema', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    initCourtListenerService(makeMockConfig(), makeMockStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('get_parties: URL-string count + relative party_types docket → schema-valid output (#22)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        const body = url.includes('/attorneys/')
          ? JSON.stringify({
              count: 1,
              next: null,
              previous: null,
              results: [
                {
                  id: 7001,
                  name: 'Jane Lawyer',
                  contact_raw: '1 Main St',
                  email: '',
                  fax: '',
                  phone: '',
                },
              ],
            })
          : JSON.stringify({
              // /parties/ count is a URL string unless ?count=on (which drops results).
              count:
                'https://www.courtlistener.com/api/rest/v4/parties/?count=on&docket=5578727&page=1',
              next: null,
              previous: null,
              results: [
                {
                  id: 1001,
                  name: 'Acme Plaintiff',
                  extra_info: '',
                  party_types: [
                    {
                      docket: 'https://www.courtlistener.com/api/rest/v4/dockets/5578727/',
                      name: 'Plaintiff',
                    },
                  ],
                  attorneys: [{ attorney_id: 7001, docket_id: 5578727, role: 1 }],
                },
                {
                  id: 1002,
                  name: 'Beta Defendant',
                  extra_info: '',
                  party_types: [
                    {
                      docket: 'https://www.courtlistener.com/api/rest/v4/dockets/5578727/',
                      name: 'Defendant',
                    },
                  ],
                  attorneys: [],
                },
              ],
            });
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
      }),
    );

    const input = getPartiesTool.input.parse({ docket_id: 5578727 });
    const result = await getPartiesTool.handler(input, ctx);

    // The bug: total_parties (z.number) received a URL string and failed .parse().
    expect(() => getPartiesTool.output.parse(result)).not.toThrow();
    // Single page (next=null, page=1) → total is the exact row count, not the URL string.
    expect(result.total_parties).toBe(2);
    expect(result.next_cursor).toBeNull();
    expect(result.parties).toHaveLength(2);
    // #29 — role resolves from party_types even though pt.docket is a `.../dockets/<id>/` URL
    // (Number(url) is NaN, so the pre-fix find() never matched and role was always null).
    expect(result.parties[0].role).toBe('Plaintiff');
    expect(result.parties[1].role).toBe('Defendant');
  });

  it('get_parties: multi-page (next set) → null total, page-number next_cursor (#22)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        const body = url.includes('/attorneys/')
          ? JSON.stringify({ count: 0, next: null, previous: null, results: [] })
          : JSON.stringify({
              count: 'https://www.courtlistener.com/api/rest/v4/parties/?count=on',
              next: 'https://www.courtlistener.com/api/rest/v4/parties/?docket=5578727&page=2',
              previous: null,
              results: [{ id: 1001, name: 'Acme', extra_info: '', party_types: [], attorneys: [] }],
            });
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
      }),
    );

    const input = getPartiesTool.input.parse({ docket_id: 5578727, page_size: 1 });
    const result = await getPartiesTool.handler(input, ctx);

    expect(() => getPartiesTool.output.parse(result)).not.toThrow();
    expect(result.total_parties).toBeNull();
    expect(result.next_cursor).toBe('2');
  });

  it('get_docket: string document_number + URL-string count + relative filepath_local (#23 #26)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        const body = url.includes('/docket-entries/')
          ? JSON.stringify({
              // Intermittent URL-string count (when CourtListener's count isn't cached).
              count:
                'https://www.courtlistener.com/api/rest/v4/docket-entries/?count=on&docket=5578727',
              next: null,
              previous: null,
              results: [
                {
                  id: 50001,
                  entry_number: 1,
                  date_filed: '2020-01-02',
                  description: 'Complaint',
                  recap_documents: [
                    {
                      id: 90001,
                      document_number: '1', // string from /docket-entries/
                      attachment_number: null,
                      description: 'Main Document',
                      is_available: true,
                      page_count: 10,
                      // relative RECAP path, not a URL
                      filepath_local:
                        'recap/gov.uscourts.nysd.458699/gov.uscourts.nysd.458699.1.0.pdf',
                    },
                  ],
                },
              ],
            })
          : JSON.stringify({
              id: 5578727,
              case_name: 'United States v. Example',
              case_name_full: '',
              court: 'https://www.courtlistener.com/api/rest/v4/courts/nysd/',
              court_id: 'nysd',
              date_filed: '2020-01-01',
              date_terminated: null,
              docket_number: '1:20-cv-00001',
              pacer_case_id: '458699',
              assigned_to_str: null,
              referred_to_str: null,
              cause: '',
              jury_demand: '',
              jurisdiction_type: 'Federal Question',
            });
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
      }),
    );

    const input = getDocketTool.input.parse({ docket_id: 5578727 });
    const result = await getDocketTool.handler(input, ctx);

    // The bug: document_number (z.number) received "1"; total_entries received a URL string.
    expect(() => getDocketTool.output.parse(result)).not.toThrow();
    expect(result.entries[0].documents[0].document_number).toBe('1');
    // URL-string count guarded → total_entries falls back to the fetched page length (a number).
    expect(typeof result.total_entries).toBe('number');
    expect(result.total_entries).toBe(1);
    // #26 — relative path becomes a directly fetchable storage URL.
    expect(result.entries[0].documents[0].filepath_local).toBe(
      'https://storage.courtlistener.com/recap/gov.uscourts.nysd.458699/gov.uscourts.nysd.458699.1.0.pdf',
    );
  });

  it('get_docket: numeric count is used directly for total_entries (#23)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        const body = url.includes('/docket-entries/')
          ? JSON.stringify({
              count: 153,
              next: null,
              previous: null,
              results: [
                {
                  id: 50001,
                  entry_number: 1,
                  date_filed: '2020-01-02',
                  description: 'Complaint',
                  recap_documents: [],
                },
              ],
            })
          : JSON.stringify({
              id: 5578727,
              case_name: 'X',
              case_name_full: '',
              court: '',
              court_id: 'nysd',
              date_filed: '2020-01-01',
              date_terminated: null,
              docket_number: '1',
              pacer_case_id: null,
              assigned_to_str: null,
              referred_to_str: null,
              cause: '',
              jury_demand: '',
              jurisdiction_type: '',
            });
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
      }),
    );
    const result = await getDocketTool.handler(
      getDocketTool.input.parse({ docket_id: 5578727 }),
      ctx,
    );
    expect(result.total_entries).toBe(153);
  });

  it('get_docket: non-null upstream next surfaces as next_cursor through the tool (#32)', async () => {
    const entryUrls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        let body: string;
        if (url.includes('/docket-entries/')) {
          entryUrls.push(url);
          body = JSON.stringify({
            count: 153,
            // page-paginated: `next` is a ...&page=N URL, not a cursor token.
            next: 'https://www.courtlistener.com/api/rest/v4/docket-entries/?docket=5578727&page=2',
            previous: null,
            results: [
              {
                id: 50001,
                entry_number: 1,
                date_filed: '2020-01-02',
                description: 'Complaint',
                recap_documents: [],
              },
            ],
          });
        } else {
          body = JSON.stringify({
            id: 5578727,
            case_name: 'United States v. Example',
            case_name_full: '',
            court: '',
            court_id: 'nysd',
            date_filed: '2020-01-01',
            date_terminated: null,
            docket_number: '1:20-cv-00001',
            pacer_case_id: null,
            assigned_to_str: null,
            referred_to_str: null,
            cause: '',
            jury_demand: '',
            jurisdiction_type: '',
          });
        }
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => body };
      }),
    );

    const input = getDocketTool.input.parse({ docket_id: 5578727, entries_page: 1 });
    const result = await getDocketTool.handler(input, ctx);

    expect(() => getDocketTool.output.parse(result)).not.toThrow();
    // page 1 requested; upstream reports a next page → next_cursor is the next page number.
    expect(new URL(entryUrls[0]).searchParams.get('page')).toBe('1');
    expect(result.entries_page).toBe(1);
    expect(result.next_cursor).toBe('2');
  });
});
