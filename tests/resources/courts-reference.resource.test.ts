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
    const params = courtsReferenceResource.params.parse({});
    const result = await courtsReferenceResource.handler(params, ctx);
    expect(typeof result).toBe('string');
    expect(result).toContain('CourtListener Court Reference');
  });

  it('includes jurisdiction type codes in the content', async () => {
    const ctx = createMockContext();
    const params = courtsReferenceResource.params.parse({});
    const result = await courtsReferenceResource.handler(params, ctx);
    expect(result).toContain('Federal Appellate');
    expect(result).toContain('scotus');
    expect(result).toContain('Rate Limit');
  });

  // #67 — the guide a model is told to read before building a query carried the same
  // 15-code table as the tool input, with the same four wrong labels.
  it("tabulates jurisdiction codes with upstream's own labels", async () => {
    const ctx = createMockContext();
    const params = courtsReferenceResource.params.parse({});
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

  it('lists available resources via list()', async () => {
    const listing = await courtsReferenceResource.list!();
    expect(listing.resources).toBeInstanceOf(Array);
    expect(listing.resources).toHaveLength(1);
    const resource = listing.resources[0];
    expect(resource).toHaveProperty('uri', 'courtlistener://reference/courts');
    expect(resource).toHaveProperty('name');
    expect(resource).toHaveProperty('mimeType', 'text/markdown');
  });
});
