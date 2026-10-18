/**
 * @fileoverview Positive page-size request boundaries.
 * @module tests/tools/bounded-pages
 */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCitationsTool } from '@/mcp-server/tools/definitions/get-citations.tool.js';
import { getDocketTool } from '@/mcp-server/tools/definitions/get-docket.tool.js';
import { searchDocketsTool } from '@/mcp-server/tools/definitions/search-dockets.tool.js';
import { searchFinancialDisclosuresTool } from '@/mcp-server/tools/definitions/search-financial-disclosures.tool.js';
import { searchJudgesTool } from '@/mcp-server/tools/definitions/search-judges.tool.js';
import { searchOralArgumentsTool } from '@/mcp-server/tools/definitions/search-oral-arguments.tool.js';
import * as service from '@/services/courtlistener/courtlistener-service.js';

afterEach(() => vi.restoreAllMocks());

import { getPartiesTool } from '@/mcp-server/tools/definitions/get-parties.tool.js';
import { searchOpinionsTool } from '@/mcp-server/tools/definitions/search-opinions.tool.js';

describe('bounded page requests', () => {
  it('retains defaults and rejects nonpositive and fractional sizes', () => {
    expect(searchOpinionsTool.input.parse({ q: 'Brown' }).page_size).toBe(20);
    for (const page_size of [0, -1, 1.5, Infinity, NaN]) {
      expect(searchOpinionsTool.input.safeParse({ q: 'Brown', page_size }).success).toBe(false);
    }
  });
  it('accepts oversized requests without discarding the requested value', () => {
    expect(searchOpinionsTool.input.parse({ q: 'Brown', page_size: 100 }).page_size).toBe(100);
    expect(getPartiesTool.input.parse({ docket_id: 1, page_size: 100 }).page_size).toBe(100);
    expect(
      getDocketTool.input.parse({ docket_id: 1, entries_page_size: 100 }).entries_page_size,
    ).toBe(100);
  });

  for (const tool of [
    searchOpinionsTool,
    searchDocketsTool,
    searchJudgesTool,
    searchOralArgumentsTool,
    searchFinancialDisclosuresTool,
    getCitationsTool,
    getPartiesTool,
    getDocketTool,
  ]) {
    it(`${tool.name} accepts positive requests and rejects invalid sizes`, () => {
      const base =
        tool === getDocketTool || tool === getPartiesTool
          ? { docket_id: 1 }
          : tool === getCitationsTool
            ? { cluster_id: 1 }
            : tool === searchFinancialDisclosuresTool
              ? {}
              : { q: 'Brown' };
      const key = tool === getDocketTool ? 'entries_page_size' : 'page_size';
      expect(tool.input.safeParse({ ...base, [key]: 100 }).success).toBe(true);
      for (const size of [0, -1, 0.5, Infinity, NaN]) {
        expect(tool.input.safeParse({ ...base, [key]: size }).success).toBe(false);
      }
    });
  }

  for (const tool of [
    searchOpinionsTool,
    searchDocketsTool,
    searchJudgesTool,
    searchOralArgumentsTool,
    searchFinancialDisclosuresTool,
  ]) {
    it(`${tool.name} clamps once, preserves full pages and cursor, and renders accounting`, async () => {
      const call = vi.fn().mockResolvedValue({
        total: 25,
        results: Array.from({ length: 25 }, (_, id) => ({ id, cluster_id: id, docket_id: id })),
        nextCursor: 'opaque-next',
      });
      vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
        searchOpinions: call,
        searchDockets: call,
        searchJudges: call,
        searchOralArguments: call,
        searchFinancialDisclosures: call,
      } as unknown as service.CourtListenerService);
      const ctx = createMockContext({
        errors: searchOpinionsTool.errors,
      });
      const raw = { q: 'Brown', page_size: 100 };
      const result =
        tool === searchOpinionsTool
          ? await searchOpinionsTool.handler(searchOpinionsTool.input.parse(raw), ctx)
          : tool === searchDocketsTool
            ? await searchDocketsTool.handler(searchDocketsTool.input.parse(raw), ctx)
            : tool === searchJudgesTool
              ? await searchJudgesTool.handler(searchJudgesTool.input.parse(raw), ctx)
              : tool === searchOralArgumentsTool
                ? await searchOralArgumentsTool.handler(
                    searchOralArgumentsTool.input.parse(raw),
                    ctx,
                  )
                : await searchFinancialDisclosuresTool.handler(
                    searchFinancialDisclosuresTool.input.parse({ page_size: 100 }),
                    ctx,
                  );
      expect(call).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ page_size: 20 }), ctx);
      expect(result.results).toHaveLength(25);
      expect(result.next_cursor).toBe('opaque-next');
      expect(result.page_sizing).toEqual({
        requested: 100,
        bounded: 20,
        actual: 25,
        upstream: 'minimum_20',
      });
      // All five formatter signatures accept their own schema-parsed result.
      const parsed = tool.output.parse(result);
      expect(parsed.page_sizing).toEqual(result.page_sizing);
      const rendered =
        tool === searchOpinionsTool
          ? searchOpinionsTool.format!(searchOpinionsTool.output.parse(result))
          : tool === searchDocketsTool
            ? searchDocketsTool.format!(searchDocketsTool.output.parse(result))
            : tool === searchJudgesTool
              ? searchJudgesTool.format!(searchJudgesTool.output.parse(result))
              : tool === searchOralArgumentsTool
                ? searchOralArgumentsTool.format!(searchOralArgumentsTool.output.parse(result))
                : searchFinancialDisclosuresTool.format!(
                    searchFinancialDisclosuresTool.output.parse(result),
                  );
      expect(JSON.stringify(rendered)).toContain('requested 100; bounded 20; actual 25');
    });
  }

  it('preserves fixed-size parties pages beyond the bounded request', async () => {
    const call = vi.fn().mockResolvedValue({
      count: 20,
      parties: Array.from({ length: 20 }, (_, id) => ({
        id,
        name: 'Party',
        role: null,
        extra_info: '',
        attorneys: [],
      })),
      next_cursor: 'parties-next',
    });
    vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
      getParties: call,
    } as unknown as service.CourtListenerService);
    const ctx = createMockContext({ errors: getPartiesTool.errors });
    const result = await getPartiesTool.handler(
      getPartiesTool.input.parse({ docket_id: 1, page_size: 100 }),
      ctx,
    );
    expect(call).toHaveBeenCalledExactlyOnceWith(1, undefined, 10, ctx);
    expect(result.page_sizing).toEqual({
      requested: 100,
      bounded: 10,
      actual: 20,
      upstream: 'fixed_20',
    });
    expect(JSON.stringify(getPartiesTool.format!(result))).toContain('bounded 10');
    expect(result.next_cursor).toBe('parties-next');
    expect(result.parties).toHaveLength(20);
  });

  it('bounds entry requests to 50 while preserving fixed 20-row pages and continuation', async () => {
    const call = vi.fn().mockResolvedValue({
      id: 1,
      docket_entries: Array.from({ length: 20 }, (_, id) => ({ id })),
      docket_entries_next_page: '2',
    });
    vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
      getDocket: call,
    } as unknown as service.CourtListenerService);
    const ctx = createMockContext({ errors: getDocketTool.errors });
    const result = await getDocketTool.handler(
      getDocketTool.input.parse({ docket_id: 1, entries_page_size: 100 }),
      ctx,
    );
    expect(call).toHaveBeenCalledExactlyOnceWith(1, 50, 1, ctx);
    expect(result.page_sizing).toEqual({
      requested: 100,
      bounded: 50,
      actual: 20,
      upstream: 'fixed_20',
    });
    expect(result.entries).toHaveLength(20);
    expect(result.next_cursor).toBe('2');
    expect(JSON.stringify(getDocketTool.format!(result))).toContain(
      'requested 100; bounded 50; actual 20',
    );
  });
});
