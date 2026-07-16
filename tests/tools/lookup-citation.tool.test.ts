/**
 * @fileoverview Tests for the lookup-citation tool.
 * @module tests/tools/lookup-citation.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupCitationTool } from '@/mcp-server/tools/definitions/lookup-citation.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';

const mockSvc = {
  lookupCitation: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

describe('lookupCitationTool', () => {
  it('resolves a valid citation string', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue({
      cluster_id: 100,
      case_name: 'Roe v. Wade',
      court: 'Supreme Court of the United States',
      date_filed: '1973-01-22',
      citations: ['410 U.S. 113', '93 S. Ct. 705'],
      normalized_citation: '410 U.S. 113',
    });
    const ctx = createMockContext();
    const input = lookupCitationTool.input.parse({ citation: '410 U.S. 113' });
    const result = await lookupCitationTool.handler(input, ctx);

    expect(result.cluster_id).toBe(100);
    expect(result.case_name).toBe('Roe v. Wade');
    expect(result.citations).toContain('410 U.S. 113');
    expect(result.normalized_citation).toBe('410 U.S. 113');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.queriedCitation).toBe('410 U.S. 113');
    expect(enrichment.notice).toBeUndefined();
  });

  it('throws not_found when citation is not in database', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockSvc.lookupCitation = vi
      .fn()
      .mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'Citation not found'));
    const ctx = createMockContext({ errors: lookupCitationTool.errors });
    const input = lookupCitationTool.input.parse({ citation: '999 X.Y. 999' });
    await expect(lookupCitationTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('enriches queriedCitation and notice when cluster_id is null', async () => {
    mockSvc.lookupCitation = vi.fn().mockResolvedValue({
      cluster_id: null,
      case_name: null,
      court: null,
      date_filed: null,
      citations: [],
      normalized_citation: null,
    });
    const ctx = createMockContext();
    const input = lookupCitationTool.input.parse({ citation: '999 F.3d 1' });
    await lookupCitationTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.queriedCitation).toBe('999 F.3d 1');
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('999 F.3d 1');
  });

  // #39 — a whitespace-only citation previously reached the /citation-lookup/
  // endpoint and spent one of the 125 daily requests on input that cannot resolve.
  describe('empty citation (#39)', () => {
    it('trims citation to empty and rejects without calling the service', async () => {
      mockSvc.lookupCitation = vi.fn();
      const ctx = createMockContext({ errors: lookupCitationTool.errors });
      const input = lookupCitationTool.input.parse({ citation: '   ' });
      expect(input.citation).toBe('');

      const err = await lookupCitationTool.handler(input, ctx).catch((e) => e);
      expect(err).toMatchObject({ data: { reason: 'empty_citation' } });
      expect(err.message).toContain('citation');
      expect(mockSvc.lookupCitation).not.toHaveBeenCalled();
    });

    it('trims incidental padding from an otherwise-valid citation', async () => {
      mockSvc.lookupCitation = vi.fn().mockResolvedValue({
        cluster_id: 100,
        case_name: 'Roe v. Wade',
        court: 'Supreme Court',
        date_filed: '1973-01-22',
        citations: ['410 U.S. 113'],
        normalized_citation: '410 U.S. 113',
      });
      const ctx = createMockContext();
      const input = lookupCitationTool.input.parse({ citation: '  410 U.S. 113  ' });
      await lookupCitationTool.handler(input, ctx);
      expect(mockSvc.lookupCitation).toHaveBeenCalledWith('410 U.S. 113', ctx);
    });
  });

  it('formats a found citation with cluster_id and case details', () => {
    const output = lookupCitationTool.output.parse({
      cluster_id: 100,
      case_name: 'Roe v. Wade',
      court: 'Supreme Court',
      date_filed: '1973-01-22',
      citations: ['410 U.S. 113'],
      normalized_citation: '410 U.S. 113',
    });
    const blocks = lookupCitationTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('100');
    expect(text).toContain('Roe v. Wade');
    expect(text).toContain('410 U.S. 113');
  });

  it('formats a not-found response without throwing', () => {
    const output = lookupCitationTool.output.parse({
      cluster_id: null,
      case_name: null,
      court: null,
      date_filed: null,
      citations: [],
      normalized_citation: null,
    });
    const blocks = lookupCitationTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('not found');
  });
});
