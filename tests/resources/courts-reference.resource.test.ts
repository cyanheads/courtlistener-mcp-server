/**
 * @fileoverview Tests for the courts-reference resource.
 * @module tests/resources/courts-reference.resource.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { courtsReferenceResource } from '@/mcp-server/resources/definitions/courts-reference.resource.js';

describe('courtsReferenceResource', () => {
  it('returns the reference content for valid params', async () => {
    const ctx = createMockContext();
    const params = courtsReferenceResource.params!.parse({});
    const result = await courtsReferenceResource.handler(params, ctx);
    expect(typeof result).toBe('string');
    expect(result).toContain('CourtListener Court Reference');
  });

  it('includes jurisdiction type codes in the content', async () => {
    const ctx = createMockContext();
    const params = courtsReferenceResource.params!.parse({});
    const result = await courtsReferenceResource.handler(params, ctx);
    expect(result).toContain('Federal Appellate');
    expect(result).toContain('scotus');
    expect(result).toContain('Rate Limit');
  });

  // #67 — the guide a model is told to read before building a query carried the same
  // 15-code table as the tool input, with the same four wrong labels.
  it("tabulates jurisdiction codes with upstream's own labels", async () => {
    const ctx = createMockContext();
    const params = courtsReferenceResource.params!.parse({});
    const result = await courtsReferenceResource.handler(params, ctx);

    expect(result).toContain('| S | State Supreme |');
    expect(result).toContain('| SS | State Special |');
    expect(result).toContain('| TT | Territory Trial |');
    expect(result).toContain('| C | Committee |');
    // Benches the table never listed at all.
    expect(result).toContain('| TRA | Tribal Appellate |');
    expect(result).toContain('| MA | Military Appellate |');
    // SAL is not one of upstream's choices, and a T filter is excluded from every
    // /courts/ response — neither belongs in a table of values to filter with.
    expect(result).not.toContain('| SAL |');
    expect(result).not.toContain('| T |');
  });

  // A build-time-constant document: 2026-07-28 clients may hold it for a day, and it
  // carries nothing caller-specific, so a shared cache may hold it too.
  it('declares a public day-long cache hint', () => {
    expect(courtsReferenceResource.cacheHint).toEqual({
      ttlMs: 86_400_000,
      cacheScope: 'public',
    });
  });

  it('lists available resources via list()', async () => {
    // `list` receives the SDK's `ServerContext`, not a handler `Context`. This
    // listing ignores it, so a minimal literal satisfies the signature.
    const serverContext = {
      mcpReq: {
        id: 'test',
        method: 'resources/list',
        signal: new AbortController().signal,
        requestState: () => undefined,
        send: () => Promise.resolve({} as never),
        notify: () => Promise.resolve(),
        log: () => Promise.resolve(),
      },
    } as unknown as Parameters<NonNullable<typeof courtsReferenceResource.list>>[0];
    const listing = await courtsReferenceResource.list!(serverContext);
    expect(listing.resources).toBeInstanceOf(Array);
    expect(listing.resources).toHaveLength(1);
    const resource = listing.resources[0]!;
    expect(resource).toHaveProperty('uri', 'courtlistener://reference/courts');
    expect(resource).toHaveProperty('name');
    expect(resource).toHaveProperty('mimeType', 'text/markdown');
  });
});
