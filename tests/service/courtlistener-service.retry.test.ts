/**
 * @fileoverview #25 regression — a 429 from CourtListener must FAIL FAST, not retry.
 * Isolated from courtlistener-service.test.ts because that suite mocks `withRetry`
 * away; here `withRetry` is the REAL framework implementation so the per-error
 * `retryable: false` opt-out is exercised end to end. Only `fetchWithTimeout` is
 * mocked (to simulate the production non-2xx throw).
 * @module tests/service/courtlistener-service.retry.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY fetchWithTimeout — keep the real withRetry so its transient-classification
// and the `data.retryable === false` opt-out run for real.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...original, fetchWithTimeout: vi.fn() };
});

import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { getPartiesTool } from '@/mcp-server/tools/definitions/get-parties.tool.js';
import { searchOpinionsTool } from '@/mcp-server/tools/definitions/search-opinions.tool.js';
import {
  CourtListenerService,
  type CourtListenerServiceConfig,
} from '@/services/courtlistener/courtlistener-service.js';

/**
 * Rate limits high enough that the pacer never queues — these suites assert error
 * classification, and pacing has its own suite (`courtlistener-service.pacing.test.ts`).
 */
const makeConfig = (token = 'secret-token'): CourtListenerServiceConfig => ({
  apiToken: token,
  mcpServerVersion: '0.0.0-test',
  rateLimitPerHour: 100_000,
  rateLimitPerMinute: 10_000,
});
const makeStorage = () => ({}) as unknown as StorageService;

/** The `rate_limited` recovery string a definition advertises in its `errors[]`. */
function declaredRateLimitHint(
  errors: readonly { reason: string; recovery: string }[] | undefined,
): string {
  const entry = errors?.find((e) => e.reason === 'rate_limited');
  if (!entry) throw new Error('Definition declares no rate_limited contract entry.');
  return entry.recovery;
}

describe('429 fail-fast (#25)', () => {
  let svc: CourtListenerService;
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    svc = new CourtListenerService(makeConfig(), makeStorage());
    ctx = createMockContext();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not retry a 429 — one upstream attempt, rateLimited carries retryable:false', async () => {
    // Production fetchWithTimeout throws on non-2xx (status, no machine-readable reason).
    vi.mocked(fetchWithTimeout).mockRejectedValue(
      new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', {
        status: 429,
        errorSource: 'FetchHttpError',
      }),
    );

    const err = (await svc.searchOpinions({ q: 'test' }, ctx).catch((e) => e)) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({ reason: 'rate_limited', retryable: false });
    // The opt-out fired: exactly ONE attempt — not the original + 3 retries the bug produced.
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    // And no exhaustion suffix, because withRetry never entered the retry loop.
    expect(err.message).not.toContain('failed after');
  });

  it('carries the transport-captured Retry-After through withRetry to the agent (#52)', async () => {
    // fetchWithTimeout attaches the upstream Retry-After header to the error data.
    vi.mocked(fetchWithTimeout).mockRejectedValue(
      new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', {
        status: 429,
        retryAfter: '47',
        errorSource: 'FetchHttpError',
      }),
    );

    const err = (await svc.searchOpinions({ q: 'test' }, ctx).catch((e) => e)) as McpError;

    // The wait time survives classification on both surfaces — data for routing, message for display.
    expect(err.data).toMatchObject({ reason: 'rate_limited', retryAfter: '47' });
    expect(err.message).toContain('Retry-After: 47s');
  });
});

describe('rate_limited recovery hint (#68)', () => {
  let svc: CourtListenerService;

  beforeEach(() => {
    svc = new CourtListenerService(makeConfig(), makeStorage());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /** A 429 the transport captured, with the header CourtListener sends alongside it. */
  function mock429(retryAfter?: string) {
    vi.mocked(fetchWithTimeout).mockRejectedValue(
      new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', {
        status: 429,
        ...(retryAfter !== undefined && { retryAfter }),
        errorSource: 'FetchHttpError',
      }),
    );
  }

  it('puts the calling tool declared hint on data.recovery.hint', async () => {
    mock429('6695');
    const ctx = createMockContext({ errors: searchOpinionsTool.errors });

    const err = (await svc.searchOpinions({ q: 'test' }, ctx).catch((e) => e)) as {
      data?: { recovery?: { hint?: string } };
    };

    expect(err.data?.recovery?.hint).toBe(declaredRateLimitHint(searchOpinionsTool.errors));
  });

  it('resolves the hint against the calling tool, not one copy shared by all of them', async () => {
    // Over the in-call wait cap, so the ladder surfaces the 429 instead of sleeping it out.
    mock429('120');
    // courtlistener_get_parties declares a longer hint — it spends 2+ requests per call.
    const ctx = createMockContext({ errors: getPartiesTool.errors });

    const err = (await svc.getParties(1, undefined, 20, ctx).catch((e) => e)) as {
      data?: { recovery?: { hint?: string } };
    };

    const partiesHint = declaredRateLimitHint(getPartiesTool.errors);
    expect(partiesHint).not.toBe(declaredRateLimitHint(searchOpinionsTool.errors));
    expect(err.data?.recovery?.hint).toBe(partiesHint);
  });

  it('omits recovery when the caller declares no rate_limited contract', async () => {
    mock429('90');
    const ctx = createMockContext();

    const err = (await svc.searchOpinions({ q: 'test' }, ctx).catch((e) => e)) as {
      data?: Record<string, unknown>;
    };

    // The resolver returns `{}` off-contract — no half-populated `recovery` key on the wire.
    expect(err.data).not.toHaveProperty('recovery');
    expect(err.data).toMatchObject({ reason: 'rate_limited', retryAfter: '90' });
  });

  it('leaves the 404 path resolving its hint from the request path', async () => {
    vi.mocked(fetchWithTimeout).mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed. Status: 404', {
        status: 404,
        errorSource: 'FetchHttpError',
      }),
    );
    const ctx = createMockContext({ errors: getPartiesTool.errors });

    const err = (await svc.getParties(999, undefined, 20, ctx).catch((e) => e)) as {
      data?: { reason?: string; recovery?: { hint?: string } };
    };

    expect(err.data?.reason).toBe('not_found');
    expect(err.data?.recovery?.hint).toContain('courtlistener_search_dockets');
  });
});
