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
import { getDocketTool } from '@/mcp-server/tools/definitions/get-docket.tool.js';
import { getPartiesTool } from '@/mcp-server/tools/definitions/get-parties.tool.js';
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
