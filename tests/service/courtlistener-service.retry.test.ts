/**
 * @fileoverview #25 regression — a 429 from CourtListener must FAIL FAST, not retry.
 * Isolated from courtlistener-service.test.ts because that suite mocks `withRetry`
 * away; here `withRetry` is the REAL framework implementation so the per-error
 * `retryable: false` opt-out is exercised end to end. Only `fetchWithTimeout` is
 * mocked (to simulate the production non-2xx throw).
 * @module tests/service/courtlistener-service.retry.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY fetchWithTimeout — keep the real withRetry so its transient-classification
// and the `data.retryable === false` opt-out run for real.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...original, fetchWithTimeout: vi.fn() };
});

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

const makeConfig = (token = 'secret-token'): AppConfig =>
  ({ apiToken: token }) as unknown as AppConfig;
const makeStorage = () => ({}) as unknown as StorageService;

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
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    // Production fetchWithTimeout throws on non-2xx (statusCode, no machine-readable reason).
    vi.mocked(fetchWithTimeout).mockRejectedValue(
      new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', {
        statusCode: 429,
        errorSource: 'FetchHttpError',
      }),
    );

    const err = (await svc.searchOpinions({ q: 'test' }, ctx).catch((e) => e)) as InstanceType<
      typeof McpError
    >;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({ reason: 'rate_limited', retryable: false });
    // The opt-out fired: exactly ONE attempt — not the original + 3 retries the bug produced.
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    // And no exhaustion suffix, because withRetry never entered the retry loop.
    expect(err.message).not.toContain('failed after');
  });
});
