/**
 * @fileoverview Retrieval snapshot lifetime, isolation, and retention behavior.
 * @module tests/service/retrieval-snapshot.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readRetrievalSnapshot } from '@/services/courtlistener/retrieval-snapshot.js';

const startedAt = '2026-11-13T16:00:00.000Z';
const completedAt = '2026-11-13T16:00:30.000Z';
const source = ['opinion', 112257, 'all'] as const;
const mib = 1024 * 1024;
let service: object;

beforeEach(() => {
  service = {};
  vi.useFakeTimers({ now: new Date(startedAt) });
});

afterEach(() => vi.useRealTimers());

it('fetches every first call and reuses completed sources on continuation', async () => {
  const fetch = vi.fn(async () => {
    vi.setSystemTime(completedAt);
    return { rows: [1] };
  });
  const scope = { service, tenantId: 'default', source };
  await expect(readRetrievalSnapshot({ ...scope, continuing: false, fetch })).resolves.toEqual({
    value: { rows: [1] },
    fetchedAt: completedAt,
  });
  await expect(readRetrievalSnapshot({ ...scope, continuing: true, fetch })).resolves.toEqual({
    value: { rows: [1] },
    fetchedAt: completedAt,
  });
  expect(fetch).toHaveBeenCalledOnce();
  fetch.mockResolvedValueOnce({ rows: [2] });
  const fresh = await readRetrievalSnapshot({ ...scope, continuing: false, fetch });
  expect(fresh.value).toEqual({ rows: [2] });
  const replay = await readRetrievalSnapshot({ ...scope, continuing: true, fetch });
  expect(replay.value).toEqual({ rows: [2] });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('expires from completion without extending the lease on replay and propagates a failed reload', async () => {
  const failed = new Error('Upstream failed');
  const fetch = vi
    .fn(async () => ({ completion: { complete: false, next_cursor: 'variants-next' } }))
    .mockRejectedValueOnce(failed);
  const request = { service, tenantId: 'default', source, continuing: true, fetch };
  await expect(readRetrievalSnapshot(request)).rejects.toBe(failed);
  await expect(readRetrievalSnapshot(request)).resolves.toMatchObject({
    value: { completion: { complete: false, next_cursor: 'variants-next' } },
    fetchedAt: startedAt,
  });
  vi.advanceTimersByTime(299_999);
  await expect(readRetrievalSnapshot(request)).resolves.toMatchObject({ fetchedAt: startedAt });
  expect(fetch).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1);
  fetch.mockRejectedValueOnce(failed);
  await expect(readRetrievalSnapshot(request)).rejects.toBe(failed);
  await expect(readRetrievalSnapshot(request)).resolves.toMatchObject({
    fetchedAt: '2026-11-13T16:05:00.000Z',
  });
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('isolates service instances, tenants, and every source tuple member', async () => {
  const fetch = vi.fn(async () => ({ rows: [] }));
  const request = { service, tenantId: 'default', source, continuing: true, fetch };
  await readRetrievalSnapshot(request);
  await readRetrievalSnapshot({ ...request, source: [...source] });
  expect(fetch).toHaveBeenCalledOnce();
  await readRetrievalSnapshot({ ...request, service: {} });
  await readRetrievalSnapshot({ ...request, tenantId: 'other' });
  await readRetrievalSnapshot({ ...request, source: ['audio', 112257, 'all'] });
  await readRetrievalSnapshot({ ...request, source: ['opinion', 112258, 'all'] });
  await readRetrievalSnapshot({ ...request, source: ['opinion', 112257, 'text'] });
  await readRetrievalSnapshot({ ...request, tenantId: undefined });
  await readRetrievalSnapshot({ ...request, tenantId: undefined });
  expect(fetch).toHaveBeenCalledTimes(8);
});

it('preserves raw sparse nested data while isolating every read from mutation', async () => {
  const original = { rows: [{ name: 'original', present: undefined }] };
  const fetch = vi.fn(async () => original);
  const request = { service, tenantId: 'default', source, continuing: true, fetch };
  const first = await readRetrievalSnapshot(request);
  first.value.rows[0]!.name = 'mutated by first caller';
  original.rows[0]!.name = 'mutated by fetcher';
  const second = await readRetrievalSnapshot(request);
  expect(second.value).toStrictEqual({ rows: [{ name: 'original', present: undefined }] });
  second.value.rows.push({ name: 'mutated on replay', present: undefined });
  const replay = await readRetrievalSnapshot(request);
  expect(replay.value).toStrictEqual({ rows: [{ name: 'original', present: undefined }] });
  expect(fetch).toHaveBeenCalledOnce();
});

it('bounds retained bytes across both services and tenants and skips oversized payloads', async () => {
  const fetch = vi.fn(async () => ({ text: 'x'.repeat(9 * mib) }));
  const one = { service, tenantId: 'one', source, continuing: true, fetch };
  const two = { ...one, service: {}, tenantId: 'two' };
  await readRetrievalSnapshot(one);
  await readRetrievalSnapshot(two);
  await readRetrievalSnapshot(two);
  expect(fetch).toHaveBeenCalledTimes(2);
  await readRetrievalSnapshot(one);
  expect(fetch).toHaveBeenCalledTimes(3);

  const huge = vi.fn(async () => ({ text: 'x'.repeat(16 * mib) }));
  const oversized = { ...one, source: ['larger'], fetch: huge };
  expect((await readRetrievalSnapshot(oversized)).value.text.length).toBe(16 * mib);
  await readRetrievalSnapshot(oversized);
  expect(huge).toHaveBeenCalledTimes(2);
  await readRetrievalSnapshot(one);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('evicts the oldest entry at the count limit and releases its retained bytes', async () => {
  const fetch = vi.fn(async () => ({ text: 'tiny snapshot' }));
  const request = { service, tenantId: 'default', continuing: true, fetch };
  for (let id = 0; id < 257; id++) {
    await readRetrievalSnapshot({ ...request, source: ['tiny', id] });
  }
  await readRetrievalSnapshot({ ...request, source: ['tiny', 256] });
  expect(fetch).toHaveBeenCalledTimes(257);
  await readRetrievalSnapshot({ ...request, source: ['tiny', 0] });
  expect(fetch).toHaveBeenCalledTimes(258);

  // Each payload leaves room for its serialization overhead, but together they
  // require evicting tiny entries and releasing the bytes those entries occupied.
  const largeFetch = vi.fn(async () => ({ text: 'x'.repeat(8 * mib - 64) }));
  const first = { ...request, fetch: largeFetch, source: ['large', 0] };
  const second = { ...first, source: ['large', 1] };
  await readRetrievalSnapshot(first);
  await readRetrievalSnapshot(second);
  await readRetrievalSnapshot(first);
  await readRetrievalSnapshot(second);
  expect(largeFetch).toHaveBeenCalledTimes(2);
});

it('keeps concurrent misses independent and neither serves nor publishes a cancelled result', async () => {
  const controller = new AbortController();
  const first = Promise.withResolvers<{ title: string }>();
  const second = Promise.withResolvers<{ title: string }>();
  const fetch = vi
    .fn(() => first.promise)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const request = { service, tenantId: 'default', source, continuing: true, fetch };
  const abandoned = readRetrievalSnapshot({ ...request, signal: controller.signal });
  const live = readRetrievalSnapshot(request);
  expect(fetch).toHaveBeenCalledTimes(2);
  controller.abort();
  second.resolve({ title: 'live' });
  await expect(live).resolves.toMatchObject({ value: { title: 'live' } });
  first.resolve({ title: 'abandoned' });
  const cancelled = { code: JsonRpcErrorCode.RequestCancelled };
  await expect(abandoned).rejects.toMatchObject(cancelled);
  await expect(
    readRetrievalSnapshot({ ...request, signal: controller.signal }),
  ).rejects.toMatchObject(cancelled);
  await expect(readRetrievalSnapshot(request)).resolves.toMatchObject({
    value: { title: 'live' },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
