/**
 * @fileoverview Upstream request costs and source timestamps on retrieval responses.
 * @module tests/tools/retrieval-snapshot-contracts.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getDocketTool } from '@/mcp-server/tools/definitions/get-docket.tool.js';
import { getFinancialDisclosureTool } from '@/mcp-server/tools/definitions/get-financial-disclosure.tool.js';
import { getOpinionTool } from '@/mcp-server/tools/definitions/get-opinion.tool.js';
import { getOralArgumentTool } from '@/mcp-server/tools/definitions/get-oral-argument.tool.js';
import {
  disposeCourtListenerService,
  initCourtListenerService,
} from '@/services/courtlistener/courtlistener-service.js';

const start = '2026-11-13T16:00:00.000Z';
const later = '2026-11-13T16:05:00.000Z';
const longText = 'A court record with details. '.repeat(1700);
const secondDocumentText = 'A separate exhibit from another filing. '.repeat(1700);
const paths: string[] = [];
let owner: number;
let text: string;

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(start) });
  paths.length = 0;
  owner = 9;
  text = longText;
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input);
    expect(url.origin).toBe('https://snapshot.invalid');
    const path = url.pathname.replace('/api/rest/v4', '');
    paths.push(path);
    switch (path) {
      case '/clusters/8/':
        return Response.json({ id: 8, docket_id: 9 });
      case '/opinions/':
        return Response.json({ results: [{ id: 10, plain_text: text }], next: null });
      case '/dockets/9/':
        return Response.json({ id: 9, court_id: 'scotus', docket_number: '22-100' });
      case '/docket-entries/':
        return Response.json({
          results: [
            {
              id: 11,
              docket: owner,
              recap_documents: [
                { id: 12, plain_text: text },
                { id: 16, plain_text: secondDocumentText },
              ],
            },
          ],
          count: 1,
          next: null,
        });
      case '/audio/13/':
        return Response.json({ id: 13, stt_transcript: text });
      case '/financial-disclosures/14/':
        return Response.json({
          id: 14,
          investments: [],
          debts: [],
          positions: [{ id: 15, position: text }],
          reimbursements: [],
          non_investment_incomes: [],
          spouse_incomes: [],
          agreements: [],
          gifts: [],
        });
      default:
        throw new Error(`Unexpected fixture URL ${url.pathname}`);
    }
  });
  initCourtListenerService(
    {
      apiToken: 'snapshot-fixture',
      baseUrl: 'https://snapshot.invalid/api/rest/v4',
      mcpServerVersion: '0.0.0-test',
      rateLimitPerMinute: 1000,
      rateLimitPerHour: 1000,
    },
    createInMemoryStorage(),
  );
});

afterEach(() => {
  disposeCourtListenerService();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const context = { tenantId: 'snapshot-tenant' };
const cases = [
  {
    label: 'opinion',
    tool: getOpinionTool,
    input: { cluster_id: 8 },
    cold: ['/clusters/8/', '/opinions/', '/dockets/9/'],
    warm: ['/dockets/9/'],
  },
  {
    label: 'selected docket',
    tool: getDocketTool,
    input: { docket_id: 9, document_ids: [12] },
    cold: ['/dockets/9/', '/docket-entries/'],
    warm: [],
  },
  { label: 'audio', tool: getOralArgumentTool, input: { id: 13 }, cold: ['/audio/13/'], warm: [] },
  {
    label: 'disclosure',
    tool: getFinancialDisclosureTool,
    input: { disclosure_id: 14 },
    cold: ['/financial-disclosures/14/'],
    warm: [],
  },
];

it.each(cases)(
  '$label measures first, warm, cold, and full responses',
  async ({ tool, input, cold, warm }) => {
    const call = async (cursor: string | undefined, expectedPaths: string[], timestamp: string) => {
      paths.length = 0;
      const wire = await runToolContract(tool, { ...input, cursor }, { context });
      expect(paths).toEqual(expectedPaths);
      expect(wire.isError).not.toBe(true);
      const value = tool.output.parse(wire.structuredContent);
      expect(value.source_fetched_at).toBe(timestamp);
      const textBlocks = wire.content.flatMap((block) =>
        block.type === 'text' ? [block.text] : [],
      );
      expect(textBlocks.join('\n').replaceAll('\\-', '-').replaceAll('\\.', '.')).toContain(
        timestamp,
      );
      expect(Buffer.byteLength(JSON.stringify(wire.content))).toBeLessThanOrEqual(24_000);
      expect(Buffer.byteLength(JSON.stringify(wire.structuredContent))).toBeLessThanOrEqual(24_000);
      return value;
    };

    const first = await call(undefined, cold, start);
    expect(first.kind).toBe('outline');
    const cursor = first.retrieval?.next_cursor ?? undefined;
    expect(cursor).toBeTypeOf('string');
    vi.advanceTimersByTime(1000);
    const warmPage = await call(cursor, warm, start);
    expect(warmPage.kind).toBe('page');
    expect(await call(cursor, warm, start)).toEqual(warmPage);
    paths.length = 0;
    const cancelled = await runToolContract(
      tool,
      { ...input, cursor },
      { context: { ...context, signal: AbortSignal.abort() } },
    );
    expect(cancelled.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(JSON.stringify(cancelled.content)).toContain('cancelled');
    expect(paths).toEqual([]);

    vi.setSystemTime(later);
    const coldPage = await call(cursor, cold, later);
    expect(coldPage.retrieval).toEqual(warmPage.retrieval);

    text = 'short replacement';
    vi.advanceTimersByTime(1000);
    const fresh = await call(undefined, cold, '2026-11-13T16:05:01.000Z');
    expect(fresh.kind).toBe('full');
    for (const expectedPaths of [warm, cold]) {
      paths.length = 0;
      const stale = await runToolContract(tool, { ...input, cursor }, { context });
      expect(paths).toEqual(expectedPaths);
      expect(stale.structuredContent).toMatchObject({
        error: { data: { reason: 'stale_cursor' } },
      });
      expect(JSON.stringify(stale.content)).toContain('stale_cursor');
      vi.advanceTimersByTime(300_000);
    }
  },
);

it('keeps overlapping document selections independently warm in one docket', async () => {
  const continuations = [];
  for (const document_ids of [[12], [12, 16], [16]]) {
    const args = { docket_id: 9, document_ids };
    paths.length = 0;
    const outline = await runToolContract(getDocketTool, args, { context });
    expect(paths).toEqual(['/dockets/9/', '/docket-entries/']);
    const value = getDocketTool.output.parse(outline.structuredContent);
    expect(value.kind).toBe('outline');
    expect(value.document_ids).toEqual(document_ids);
    const cursor = value.retrieval?.next_cursor ?? undefined;
    expect(cursor).toBeTypeOf('string');

    paths.length = 0;
    const request = { ...args, cursor };
    const page = await runToolContract(getDocketTool, request, { context });
    expect(paths).toEqual([]);
    expect(page.structuredContent).toMatchObject({
      kind: 'page',
      document_ids,
      selected_documents: [{ id: document_ids[0], entry_id: 11 }],
      source_fetched_at: new Date().toISOString(),
    });
    expect(JSON.stringify(page.content)).toContain(
      document_ids[0] === 12
        ? 'A court record with details'
        : 'A separate exhibit from another filing',
    );
    continuations.push({ request, page });
    vi.advanceTimersByTime(1000);
  }

  for (const { request, page } of continuations) {
    paths.length = 0;
    const replay = await runToolContract(getDocketTool, request, { context });
    expect(paths).toEqual([]);
    expect(replay).toEqual(page);
  }
});

it('never caches an ownership failure and keeps default docket listing live', async () => {
  const args = { docket_id: 9, document_ids: [12] };
  const first = await runToolContract(getDocketTool, args, { context });
  const cursor =
    getDocketTool.output.parse(first.structuredContent).retrieval?.next_cursor ?? undefined;
  expect(cursor).toBeTypeOf('string');
  vi.setSystemTime(later);
  owner = 99;
  const rejected = await runToolContract(getDocketTool, { ...args, cursor }, { context });
  expect(rejected.structuredContent).toMatchObject({
    error: { data: { reason: 'document_ownership_unverified' } },
  });
  owner = 9;
  paths.length = 0;
  const recovered = await runToolContract(getDocketTool, { ...args, cursor }, { context });
  expect(recovered.isError).not.toBe(true);
  expect(paths).toEqual(['/dockets/9/', '/docket-entries/']);
  paths.length = 0;
  for (let i = 0; i < 2; i++) {
    const listing = await runToolContract(getDocketTool, { docket_id: 9 }, { context });
    expect(listing.isError).not.toBe(true);
    expect(listing.structuredContent).not.toHaveProperty('source_fetched_at');
  }
  expect(paths).toEqual(['/dockets/9/', '/docket-entries/', '/dockets/9/', '/docket-entries/']);
});
