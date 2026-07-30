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
  next_cursor: null,
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
    // page defaults to 1; a single-page result reports no continuation
    expect(result.page).toBe(1);
    expect(result.next_cursor).toBeNull();

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(2);
  });

  it('threads page and surfaces next_cursor when more pages remain (#35)', async () => {
    // /courts/ caps at ~20 rows/page; the service returns the next page number as next_cursor.
    mockSvc.listCourts = vi
      .fn()
      .mockResolvedValue({ total: 472, next_cursor: '3', courts: baseCourtsResult.courts });
    const ctx = createMockContext();
    const input = lookupCourtsTool.input.parse({ page: 2 });
    const result = await lookupCourtsTool.handler(input, ctx);

    // page is threaded to the service (pre-fix the service took no page and always fetched page 1)
    expect(mockSvc.listCourts).toHaveBeenCalledWith(expect.objectContaining({ page: 2 }), ctx);
    // handler echoes the current page and the derived continuation cursor
    expect(result.page).toBe(2);
    expect(result.next_cursor).toBe('3');
  });

  // #49 — upstream's `in_use` is a boolean exact-match filter, so in_use=true and
  // in_use=false return disjoint sets (472 active + 2887 inactive = 3359 total). The
  // old boolean input defaulted to true and had no way to omit the filter, which left
  // the full list unreachable and made `in_use: false` *exclude* the active bench.
  describe('status tri-state (#49)', () => {
    beforeEach(() => {
      mockSvc.listCourts = vi.fn().mockResolvedValue({ total: 0, next_cursor: null, courts: [] });
    });

    it("maps status='active' (the default) to in_use=true", async () => {
      const ctx = createMockContext();
      const input = lookupCourtsTool.input.parse({ jurisdiction: 'F' });
      expect(input.status).toBe('active');
      await lookupCourtsTool.handler(input, ctx);
      expect(mockSvc.listCourts).toHaveBeenCalledWith(
        expect.objectContaining({ jurisdiction: 'F', in_use: true }),
        ctx,
      );
    });

    it("maps status='inactive' to in_use=false", async () => {
      const ctx = createMockContext();
      const input = lookupCourtsTool.input.parse({ status: 'inactive' });
      await lookupCourtsTool.handler(input, ctx);
      expect(mockSvc.listCourts).toHaveBeenCalledWith(
        expect.objectContaining({ in_use: false }),
        ctx,
      );
    });

    it("maps status='any' to no in_use filter, making the full court list reachable", async () => {
      const ctx = createMockContext();
      const input = lookupCourtsTool.input.parse({ status: 'any' });
      await lookupCourtsTool.handler(input, ctx);
      // The whole point of the tri-state: omitting the param is the only way upstream
      // returns both benches. A forwarded boolean — either value — cannot express this.
      const call = (mockSvc.listCourts as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
      expect(call.in_use).toBeUndefined();
    });

    it("names status in the empty-result notice and points at 'any' rather than in_use=false", async () => {
      const ctx = createMockContext();
      const input = lookupCourtsTool.input.parse({ jurisdiction: 'TT' });
      await lookupCourtsTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('status=active');
      expect(notice).toContain("status='any'");
      // The pre-fix hint recommended the setting that caused the bug.
      expect(notice).not.toContain('in_use=false');
    });

    it("omits the 'any' suggestion once the caller is already searching both benches", async () => {
      const ctx = createMockContext();
      const input = lookupCourtsTool.input.parse({ status: 'any', jurisdiction: 'TT' });
      await lookupCourtsTool.handler(input, ctx);

      const notice = getEnrichment(ctx).notice as string;
      expect(notice).toContain('status=any');
      expect(notice).not.toContain("status='any'");
    });
  });

  it('throws when service throws', async () => {
    mockSvc.listCourts = vi.fn().mockRejectedValue(new Error('rate limit'));
    const ctx = createMockContext();
    const input = lookupCourtsTool.input.parse({});
    await expect(lookupCourtsTool.handler(input, ctx)).rejects.toThrow();
  });

  it('formats output as a table including short_name column', () => {
    const output = lookupCourtsTool.output.parse({
      page: 1,
      next_cursor: null,
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

  it('renders page and the next-page continuation in content[] (#35)', () => {
    const output = lookupCourtsTool.output.parse({
      page: 2,
      next_cursor: '3',
      courts: [
        {
          id: 'ca9',
          full_name: 'Court of Appeals for the Ninth Circuit',
          short_name: 'Ninth Circuit',
          citation_string: '9th Cir.',
          jurisdiction: 'F',
          has_opinion_scraper: true,
          has_oral_argument_scraper: true,
        },
      ],
    });
    const blocks = lookupCourtsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // Pre-fix, output had no page/next_cursor and format rendered neither — these fail then.
    expect(text).toContain('**Page:** 2');
    expect(text).toContain('Next cursor');
    expect(text).toContain('pass page=3');
  });

  it('renders the continuation on an empty page instead of returning early (#35)', () => {
    // The local empty-results branch must not swallow the next_cursor line.
    const output = lookupCourtsTool.output.parse({ page: 1, next_cursor: '2', courts: [] });
    const blocks = lookupCourtsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No courts');
    // Pre-fix, the empty branch early-returned before any continuation could render.
    expect(text).toContain('pass page=2');
  });

  it('format handles empty results', () => {
    const output = lookupCourtsTool.output.parse({ page: 1, next_cursor: null, courts: [] });
    const blocks = lookupCourtsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No courts');
  });
});
