/**
 * @fileoverview #69 — requests are paced to CourtListener's rate-limit windows.
 * The pacer and `withRetry` are both the REAL framework implementations; only
 * `fetchWithTimeout` is mocked, so the queue, the per-call wait cap, the shared 429
 * cooldown gate, and the shed→`rate_limited` remap all run for real. Fake timers
 * stand in for the windows — every wait here is a minute or more of wall clock.
 * @module tests/service/courtlistener-service.pacing.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY fetchWithTimeout — the pacer and the retry ladder are what these tests exercise.
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

const EMPTY_PAGE = '{"count":0,"next":null,"previous":null,"results":[]}';

const makeConfig = (
  overrides: Partial<CourtListenerServiceConfig> = {},
): CourtListenerServiceConfig => ({
  apiToken: 'secret-token',
  mcpServerVersion: '0.0.0-test',
  rateLimitPerHour: 1_000,
  rateLimitPerMinute: 2,
  ...overrides,
});

const makeStorage = () => ({}) as unknown as StorageService;

/** A 2xx the service's JSON path accepts. */
function ok(body = EMPTY_PAGE) {
  return { text: async () => body } as unknown as Response;
}

/** The 429 shape `fetchWithTimeout` throws, with the header CourtListener sends. */
function upstream429(retryAfter: string) {
  return new McpError(JsonRpcErrorCode.RateLimited, 'Fetch failed. Status: 429', {
    status: 429,
    retryAfter,
    errorSource: 'FetchHttpError',
  });
}

/** Lets pending microtasks settle without moving the clock more than `ms`. */
const settle = (ms = 10) => vi.advanceTimersByTimeAsync(ms);

describe('request pacing (#69)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(fetchWithTimeout).mockResolvedValue(ok());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('queues a request the window cannot start yet, then lets it through', async () => {
    const svc = new CourtListenerService(makeConfig(), makeStorage());
    const ctx = createMockContext();

    // Two starts spend the 2/min window, spaced so the third projects a wait inside the cap.
    const first = svc.searchOpinions({ q: 'a' }, ctx);
    await settle();
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    const second = svc.searchOpinions({ q: 'b' }, ctx);
    await settle();
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);

    // The window now readmits at t=60s — a ~40s wait, inside the 45s cap, so this one queues.
    const third = svc.searchOpinions({ q: 'c' }, ctx);
    await settle();
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
    await expect(Promise.all([first, second, third])).resolves.toHaveLength(3);
    svc.dispose();
  });

  it('sheds a call whose projected wait exceeds the cap, spending no request', async () => {
    const svc = new CourtListenerService(makeConfig(), makeStorage());
    const ctx = createMockContext({ errors: searchOpinionsTool.errors });

    await Promise.all([svc.searchOpinions({ q: 'a' }, ctx), svc.searchOpinions({ q: 'b' }, ctx)]);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);

    // The window readmits a full minute out — past the 45s budget, so this fails at once.
    const err = (await svc.searchOpinions({ q: 'c' }, ctx).catch((e) => e)) as McpError;

    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(err.data).toMatchObject({ reason: 'rate_limited', retryable: false, retryAfter: '60' });
    expect(err.message).toContain('no request was sent');
    // The shed is published under the declared reason, so it carries the declared hint.
    expect((err.data as { recovery?: { hint?: string } }).recovery?.hint).toContain(
      'Wait out the Retry-After interval',
    );
    // No third request reached CourtListener.
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    svc.dispose();
  });

  it('closes the gate on a 429 so a concurrent caller waits instead of spending a request', async () => {
    const svc = new CourtListenerService(makeConfig({ rateLimitPerMinute: 10 }), makeStorage());
    const ctx = createMockContext();

    // The window is wide open here — the cooldown gate is the only thing that can hold a caller.
    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(upstream429('20'));
    const gated = svc.searchOpinions({ q: 'a' }, ctx);
    await settle();
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);

    const bystander = svc.searchOpinions({ q: 'b' }, ctx);
    await vi.advanceTimersByTimeAsync(5_000);
    // Still nothing sent: the bystander is queued behind a gate it never triggered.
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    // Gate open: the bystander goes, and the 429'd call takes its honored second attempt.
    expect(fetchWithTimeout).toHaveBeenCalledTimes(3);
    await expect(bystander).resolves.toMatchObject({ total: 0 });
    await expect(gated).resolves.toMatchObject({ total: 0 });
    svc.dispose();
  });

  it('waits out a Retry-After inside the call and returns the retried result', async () => {
    const svc = new CourtListenerService(makeConfig({ rateLimitPerMinute: 10 }), makeStorage());
    const ctx = createMockContext();

    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(upstream429('15'));
    const call = svc.searchOpinions({ q: 'a' }, ctx);
    await settle();
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    await expect(call).resolves.toMatchObject({ total: 0 });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    svc.dispose();
  });

  it('fails fast on a reset it cannot wait out, and sheds the callers behind it', async () => {
    const svc = new CourtListenerService(makeConfig({ rateLimitPerMinute: 10 }), makeStorage());
    const ctx = createMockContext();

    // An hour-window reset: far past the in-call wait budget.
    vi.mocked(fetchWithTimeout).mockRejectedValueOnce(upstream429('600'));
    const err = (await svc.searchOpinions({ q: 'a' }, ctx).catch((e) => e)) as McpError;

    expect(err.data).toMatchObject({ reason: 'rate_limited', retryAfter: '600' });
    expect(err.message).toContain('Retry-After: 600s');
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);

    // The gate stays shut, capped at 120s, so the next caller is refused without a request
    // and told when the queue reopens — not when CourtListener's own window does.
    const shed = (await svc.searchOpinions({ q: 'b' }, ctx).catch((e) => e)) as McpError;
    expect(shed.data).toMatchObject({ reason: 'rate_limited', retryAfter: '120' });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    svc.dispose();
  });

  it('meters every upstream request of one tool call against the same window', async () => {
    const svc = new CourtListenerService(makeConfig(), makeStorage());
    const ctx = createMockContext({ errors: getPartiesTool.errors });

    // get_parties spends two requests per call: the party page, then the attorney roster.
    vi.mocked(fetchWithTimeout)
      .mockResolvedValueOnce(
        ok(
          '{"count":1,"next":null,"previous":null,"results":[{"id":1,"name":"Acme Corp","extra_info":"","party_types":[{"docket":7,"name":"Plaintiff"}],"attorneys":[{"attorney_id":9,"docket_id":7,"role":2,"date_action":null}]}]}',
        ),
      )
      .mockResolvedValueOnce(
        ok(
          '{"count":1,"next":null,"previous":null,"results":[{"id":9,"name":"Jane Roe","contact_raw":"1 Main St"}]}',
        ),
      );

    const parties = await svc.getParties(7, undefined, 20, ctx);
    expect(parties.parties[0]?.attorneys[0]?.name).toBe('Jane Roe');
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);

    // Both of those came out of the shared 2/min window, so the next call finds it empty.
    const err = (await svc.searchOpinions({ q: 'a' }, ctx).catch((e) => e)) as McpError;
    expect(err.data).toMatchObject({ reason: 'rate_limited', retryAfter: '60' });
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
    svc.dispose();
  });

  it('rejects a queued caller when the service is disposed', async () => {
    const svc = new CourtListenerService(makeConfig(), makeStorage());
    const ctx = createMockContext();

    const first = svc.searchOpinions({ q: 'a' }, ctx);
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    const second = svc.searchOpinions({ q: 'b' }, ctx);
    await settle();
    const queued = svc.searchOpinions({ q: 'c' }, ctx);
    await settle();
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);

    svc.dispose();

    const err = (await queued.catch((e) => e)) as McpError;
    expect(err.code).toBe(JsonRpcErrorCode.RequestCancelled);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});
