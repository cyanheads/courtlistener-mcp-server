/**
 * @fileoverview Attorney resolution through the real service, pacer, and tool contract.
 * @module tests/tools/attorney-budget.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getPartiesTool } from '@/mcp-server/tools/definitions/get-parties.tool.js';
import {
  disposeCourtListenerService,
  initCourtListenerService,
} from '@/services/courtlistener/courtlistener-service.js';

const fetchStub = vi.fn<typeof fetch>();
function initialize(budget: number) {
  initCourtListenerService(
    {
      apiToken: 'fixture',
      mcpServerVersion: 'test',
      rateLimitPerMinute: budget,
      rateLimitPerHour: 5000,
    },
    createInMemoryStorage(),
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', fetchStub);
  fetchStub.mockReset();
  initialize(20);
  fetchStub.mockImplementation(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/parties/'))
      return Response.json({
        count: 1,
        next: null,
        results: [
          {
            id: 1,
            name: 'Party',
            extra_info: '',
            party_types: [],
            attorneys: [1, 2, 3, 4, 5, 6].map((attorney_id) => ({
              attorney_id,
              docket_id: 7,
              role: 2,
            })),
          },
        ],
      });
    const page = Number(url.searchParams.get('cursor') ?? 1);
    return Response.json({
      count: 6,
      next:
        page < 6 ? `https://www.courtlistener.com/api/rest/v4/attorneys/?cursor=${page + 1}` : null,
      results: [{ id: page, name: `Counsel ${page}`, contact_raw: `Contact ${page}` }],
    });
  });
});
afterEach(() => {
  disposeCourtListenerService();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('characterizes the existing five-page cap with adequate request budget', async () => {
  const result = await runToolContract(getPartiesTool, { docket_id: 7 });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    attorney_resolution: { status: 'capped', unresolved_ids: [6], next_cursor: '6' },
  });
  expect(JSON.stringify(result.content)).toContain('Counsel 5');
  expect(fetchStub).toHaveBeenCalledTimes(6);
});
it('retains four fetched roster pages when the default minute budget sheds the fifth', async () => {
  initialize(5);
  const result = await runToolContract(getPartiesTool, { docket_id: 7, page_size: 100 });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    parties: [
      {
        id: 1,
        attorneys: [1, 2, 3, 4]
          .map((id) => ({
            attorney_id: id,
            name: `Counsel ${id}`,
            contact_raw: `Contact ${id}`,
            resolution: 'resolved',
          }))
          .concat(
            [5, 6].map((id) => ({
              attorney_id: id,
              name: '',
              contact_raw: '',
              resolution: 'not_fetched',
            })),
          ),
      },
    ],
    attorney_resolution: { status: 'capped', unresolved_ids: [5, 6], next_cursor: '5' },
  });
  const text = JSON.stringify(result.content);
  for (const value of [
    'capped',
    '5, 6',
    'roster cursor: 5',
    'Counsel 4',
    'Contact 4',
    'not_fetched',
  ])
    expect(text).toContain(value);
  expect(fetchStub).toHaveBeenCalledTimes(5);
});
it('preserves a local shed before any roster page', async () => {
  initialize(1);
  const result = await runToolContract(getPartiesTool, { docket_id: 7 });
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.RateLimited, data: { reason: 'rate_limited' } },
  });
  expect(JSON.stringify(result.content)).toContain('Retry-After');
  expect(fetchStub).toHaveBeenCalledTimes(1);
});
it('completes resolution with adequate budget', async () => {
  const normal = fetchStub.getMockImplementation()!;
  fetchStub.mockImplementation((input, init) =>
    new URL(String(input)).pathname.endsWith('/attorneys/')
      ? Promise.resolve(
          Response.json({
            count: 6,
            next: null,
            results: [1, 2, 3, 4, 5, 6].map((id) => ({
              id,
              name: `Counsel ${id}`,
              contact_raw: '',
            })),
          }),
        )
      : normal(input, init),
  );
  const result = await runToolContract(getPartiesTool, { docket_id: 7 });
  expect(result.structuredContent).toMatchObject({
    attorney_resolution: { status: 'resolved', unresolved_ids: [], next_cursor: null },
  });
  expect(JSON.stringify(result.content)).toContain('Attorney resolution:** resolved');
  expect(fetchStub).toHaveBeenCalledTimes(2);
});
it('preserves an empty terminal party page without attorney requests', async () => {
  fetchStub.mockResolvedValue(Response.json({ count: 1, next: null, results: [] }));
  const result = await runToolContract(getPartiesTool, { docket_id: 7, cursor: 'past-end' });
  expect(result.structuredContent).toMatchObject({
    parties: [],
    attorney_resolution: { status: 'resolved', unresolved_ids: [], next_cursor: null },
  });
  expect(JSON.stringify(result.content)).toContain('No party data');
  expect(fetchStub).toHaveBeenCalledOnce();
});
it('rejects invalid input before any request', async () => {
  expect((await runToolContract(getPartiesTool, { docket_id: Number.NaN })).isError).toBe(true);
  expect(fetchStub).not.toHaveBeenCalled();
});
it.each([429, 403])('preserves upstream HTTP%i after roster progress', async (status) => {
  const normal = fetchStub.getMockImplementation()!;
  fetchStub.mockImplementation((input, init) =>
    new URL(String(input)).searchParams.get('cursor') === '2'
      ? Promise.resolve(Response.json({}, { status }))
      : normal(input, init),
  );
  const result = await runToolContract(getPartiesTool, { docket_id: 7 });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code: status === 429 ? JsonRpcErrorCode.RateLimited : JsonRpcErrorCode.Forbidden },
  });
  expect(fetchStub).toHaveBeenCalledTimes(3);
});
it('propagates cancellation on a later roster page', async () => {
  const controller = new AbortController();
  const normal = fetchStub.getMockImplementation()!;
  fetchStub.mockImplementation((input, init) => {
    if (new URL(String(input)).searchParams.get('cursor') === '2') {
      controller.abort(new DOMException('Cancelled', 'AbortError'));
      return Promise.reject(controller.signal.reason);
    }
    return normal(input, init);
  });
  const result = await runToolContract(
    getPartiesTool,
    { docket_id: 7 },
    { context: { signal: controller.signal } },
  );
  expect(result.structuredContent).toMatchObject({
    error: { code: JsonRpcErrorCode.RequestCancelled },
  });
  expect(JSON.stringify(result.content)).toContain('aborted');
  expect(fetchStub).toHaveBeenCalledTimes(3);
});
