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
