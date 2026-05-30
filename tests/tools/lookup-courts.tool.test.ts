/**
 * @fileoverview Tests for the lookup-courts tool.
 * @module tests/tools/lookup-courts.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupCourtsTool } from '@/mcp-server/tools/definitions/lookup-courts.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';

const mockSvc = {
  listCourts: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

const baseCourtsResult = {
  total: 2,
  courts: [
    {
      id: 'scotus',
      full_name: 'Supreme Court of the United States',
      short_name: 'SCOTUS',
      citation_string: 'U.S.',
      jurisdiction: 'F',
      has_opinion_scraper: true,
      has_oral_argument_scraper: true,
      in_use: true,
    },
    {
      id: 'ca9',
      full_name: 'Court of Appeals for the Ninth Circuit',
      short_name: 'Ninth Circuit',
      citation_string: '9th Cir.',
      jurisdiction: 'F',
      has_opinion_scraper: true,
      has_oral_argument_scraper: true,
      in_use: true,
    },
  ],
};

describe('lookupCourtsTool', () => {
  it('returns mapped court records', async () => {
    mockSvc.listCourts = vi.fn().mockResolvedValue(baseCourtsResult);
    const ctx = createMockContext();
    const input = lookupCourtsTool.input.parse({});
    const result = await lookupCourtsTool.handler(input, ctx);

    expect(result.courts).toHaveLength(2);
    expect(result.courts[0]).toMatchObject({
      id: 'scotus',
      full_name: 'Supreme Court of the United States',
      short_name: 'SCOTUS',
      citation_string: 'U.S.',
      jurisdiction: 'F',
      has_opinion_scraper: true,
    });

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(2);
  });

  it('passes jurisdiction and in_use filters to service', async () => {
    mockSvc.listCourts = vi.fn().mockResolvedValue({ total: 0, courts: [] });
    const ctx = createMockContext();
    const input = lookupCourtsTool.input.parse({ jurisdiction: 'F', in_use: false });
    await lookupCourtsTool.handler(input, ctx);
    expect(mockSvc.listCourts).toHaveBeenCalledWith(
      expect.objectContaining({ jurisdiction: 'F', in_use: false }),
      ctx,
    );
  });

  it('throws when service throws', async () => {
    mockSvc.listCourts = vi.fn().mockRejectedValue(new Error('rate limit'));
    const ctx = createMockContext();
    const input = lookupCourtsTool.input.parse({});
    await expect(lookupCourtsTool.handler(input, ctx)).rejects.toThrow();
  });

  it('formats output as a table including short_name column', () => {
    const output = lookupCourtsTool.output.parse({
      courts: [
        {
          id: 'scotus',
          full_name: 'Supreme Court of the United States',
          short_name: 'SCOTUS',
          citation_string: 'U.S.',
          jurisdiction: 'F',
          has_opinion_scraper: true,
          has_oral_argument_scraper: true,
        },
      ],
    });
    const blocks = lookupCourtsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('scotus');
    expect(text).toContain('Supreme Court of the United States');
    // short_name must be rendered for parity
    expect(text).toContain('SCOTUS');
    expect(text).toContain('U.S.');
  });

  it('format handles empty results', () => {
    const output = lookupCourtsTool.output.parse({ courts: [] });
    const blocks = lookupCourtsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No courts');
  });
});
