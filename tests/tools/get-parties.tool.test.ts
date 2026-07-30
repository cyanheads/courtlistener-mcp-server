/**
 * @fileoverview Tests for the get-parties tool.
 * @module tests/tools/get-parties.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPartiesTool } from '@/mcp-server/tools/definitions/get-parties.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';
import type { Party } from '@/services/courtlistener/types.js';

const mockSvc = {
  getParties: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

const basePlaintiff: Party = {
  id: 1001,
  name: 'Apple Inc.',
  role: 'Plaintiff',
  extra_info: '',
  attorneys: [
    {
      attorney_id: 5001,
      name: 'Harold Lee',
      contact_raw: '1 Infinite Loop, Cupertino CA 95014\n(408) 996-1010',
      role_code: 2,
      role: 'Lead attorney',
      date_action: null,
    },
  ],
};

const baseDefendant: Party = {
  id: 1002,
  name: 'Samsung Electronics Co., Ltd.',
  role: 'Defendant',
  extra_info: 'South Korean Corporation',
  attorneys: [
    {
      attorney_id: 5002,
      name: 'Quinn Emanuel',
      contact_raw: '50 California St., San Francisco CA 94111',
      role_code: 6,
      role: 'Terminated',
      date_action: '2013-11-04',
    },
  ],
};

const baseServiceResult = {
  count: 2,
  next_cursor: null,
  parties: [basePlaintiff, baseDefendant],
};

describe('getPartiesTool', () => {
  it('returns mapped parties with roles and attorneys', async () => {
    mockSvc.getParties = vi.fn().mockResolvedValue(baseServiceResult);
    const ctx = createMockContext();
    const input = getPartiesTool.input.parse({ docket_id: 8000 });
    const result = await getPartiesTool.handler(input, ctx);

    expect(result.docket_id).toBe(8000);
    expect(result.total_parties).toBe(2);
    expect(result.next_cursor).toBeNull();
    expect(result.parties).toHaveLength(2);

    const plaintiff = result.parties[0];
    expect(plaintiff.id).toBe(1001);
    expect(plaintiff.name).toBe('Apple Inc.');
    expect(plaintiff.role).toBe('Plaintiff');
    expect(plaintiff.attorneys).toHaveLength(1);
    expect(plaintiff.attorneys[0].attorney_id).toBe(5001);
    expect(plaintiff.attorneys[0].name).toBe('Harold Lee');
    expect(plaintiff.attorneys[0].role_code).toBe(2);
    expect(plaintiff.attorneys[0].role).toBe('Lead attorney');
    expect(result.parties[1].attorneys[0].role).toBe('Terminated');
    expect(result.parties[1].attorneys[0].date_action).toBe('2013-11-04');
  });

  // #61 — /parties/ is cursor-paginated (PartyViewSet.ordering = "-id", which sits in its
  // cursor_ordering_fields), so the old numeric `page` input selected nothing and every
  // page past the first re-served page 1.
  describe('cursor pagination (#61)', () => {
    const CURSOR = 'cD0yMDI0LTAxLTAxKzAwJTNBMDA%3D';

    it('threads the opaque cursor to the service, not a page number', async () => {
      mockSvc.getParties = vi.fn().mockResolvedValue({ count: 0, next_cursor: null, parties: [] });
      const ctx = createMockContext();
      const input = getPartiesTool.input.parse({ docket_id: 9999, cursor: CURSOR, page_size: 5 });
      await getPartiesTool.handler(input, ctx);
      expect(mockSvc.getParties).toHaveBeenCalledWith(9999, CURSOR, 5, ctx);
    });

    it('sends no cursor on a first-page call', async () => {
      mockSvc.getParties = vi.fn().mockResolvedValue({ count: 0, next_cursor: null, parties: [] });
      const ctx = createMockContext();
      const input = getPartiesTool.input.parse({ docket_id: 9999 });
      await getPartiesTool.handler(input, ctx);
      expect(mockSvc.getParties).toHaveBeenCalledWith(9999, undefined, 10, ctx);
    });

    it('round-trips next_cursor back as cursor without reinterpreting it', async () => {
      mockSvc.getParties = vi
        .fn()
        .mockResolvedValue({ count: null, next_cursor: CURSOR, parties: [basePlaintiff] });
      const ctx = createMockContext();
      const first = await getPartiesTool.handler(
        getPartiesTool.input.parse({ docket_id: 8000 }),
        ctx,
      );
      expect(first.next_cursor).toBe(CURSOR);

      // The token the caller hands back must reach the service verbatim — the pre-fix
      // path derived `page + 1` from it, which upstream ignores.
      await getPartiesTool.handler(
        getPartiesTool.input.parse({ docket_id: 8000, cursor: first.next_cursor ?? undefined }),
        ctx,
      );
      expect(mockSvc.getParties).toHaveBeenLastCalledWith(8000, CURSOR, 10, ctx);
    });

    it('rejects a numeric page value, which the old input silently accepted', () => {
      // `page` is gone; a caller passing 2 gets a validation error instead of page 1 again.
      expect(() => getPartiesTool.input.parse({ docket_id: 8000, cursor: 2 })).toThrow();
    });
  });

  it('returns null total_parties when the service cannot derive a count (multi-page)', async () => {
    mockSvc.getParties = vi.fn().mockResolvedValue({
      count: null,
      next_cursor: 'cD0xMDA%3D',
      parties: [basePlaintiff],
    });
    const ctx = createMockContext();
    const input = getPartiesTool.input.parse({ docket_id: 8000, page_size: 1 });
    const result = await getPartiesTool.handler(input, ctx);
    expect(result.total_parties).toBeNull();
    expect(result.next_cursor).toBe('cD0xMDA%3D');
    // The framework validates against output.extend(enrichment) — the schema advertised in
    // tools/list — so the enrichment twin of an unknown count must be optional too (#57).
    // Asserting the bare output schema here is what let the required totalCount ship.
    expect(() =>
      getPartiesTool.output.extend(getPartiesTool.enrichment).parse(result),
    ).not.toThrow();
  });

  it('throws not_found when service throws NotFound', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockSvc.getParties = vi
      .fn()
      .mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'not found'));
    const ctx = createMockContext({ errors: getPartiesTool.errors });
    const input = getPartiesTool.input.parse({ docket_id: 99999 });
    await expect(getPartiesTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('throws when service throws for rate limit', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockSvc.getParties = vi
      .fn()
      .mockRejectedValue(new McpError(JsonRpcErrorCode.RateLimited, 'rate limited'));
    const ctx = createMockContext({ errors: getPartiesTool.errors });
    const input = getPartiesTool.input.parse({ docket_id: 8000 });
    await expect(getPartiesTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
    });
  });

  it('handles sparse payload — party with null role and no attorneys', async () => {
    const sparseParty: Party = {
      id: 1003,
      name: 'Unknown Intervenor',
      role: null,
      extra_info: '',
      attorneys: [],
    };
    mockSvc.getParties = vi.fn().mockResolvedValue({
      count: 1,
      next_cursor: null,
      parties: [sparseParty],
    });
    const ctx = createMockContext();
    const input = getPartiesTool.input.parse({ docket_id: 8000 });
    const result = await getPartiesTool.handler(input, ctx);

    expect(result.parties[0].role).toBeNull();
    expect(result.parties[0].attorneys).toHaveLength(0);
  });

  it('formats output with all required fields', () => {
    const output = getPartiesTool.output.parse({
      docket_id: 8000,
      total_parties: 2,
      next_cursor: null,
      parties: [
        {
          id: 1001,
          name: 'Apple Inc.',
          role: 'Plaintiff',
          extra_info: '',
          attorneys: [
            {
              attorney_id: 5001,
              name: 'Harold Lee',
              contact_raw: '1 Infinite Loop',
              role_code: 2,
              role: 'Lead attorney',
              date_action: null,
            },
          ],
        },
        {
          id: 1002,
          name: 'Samsung Electronics',
          role: 'Defendant',
          extra_info: 'South Korean Corporation',
          attorneys: [],
        },
      ],
    });
    const blocks = getPartiesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;

    // docket_id must be rendered
    expect(text).toContain('8000');
    // total_parties must be rendered
    expect(text).toContain('2');
    // party name and role must be rendered
    expect(text).toContain('Apple Inc.');
    expect(text).toContain('Plaintiff');
    expect(text).toContain('Samsung Electronics');
    expect(text).toContain('Defendant');
    // attorney info must be rendered — including the decoded role label (#54)
    expect(text).toContain('Harold Lee');
    expect(text).toContain('5001');
    expect(text).toContain('Lead attorney');
    // extra_info must be rendered
    expect(text).toContain('South Korean Corporation');
    // party id must be rendered
    expect(text).toContain('1001');
    expect(text).toContain('1002');
  });

  it('format renders the continuation as the cursor token, not a page number (#61)', () => {
    const output = getPartiesTool.output.parse({
      docket_id: 8000,
      total_parties: 20,
      next_cursor: 'cD0xMDA%3D',
      parties: [
        {
          id: 1001,
          name: 'Apple Inc.',
          role: 'Plaintiff',
          extra_info: '',
          attorneys: [],
        },
      ],
    });
    const blocks = getPartiesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('cursor=cD0xMDA%3D');
    // Pre-fix this rendered `page=2`, telling the caller to do the thing that fails.
    expect(text).not.toContain('page=2');
  });

  it('format renders "unknown" when total_parties is null', () => {
    const output = getPartiesTool.output.parse({
      docket_id: 8000,
      total_parties: null,
      next_cursor: null,
      parties: [],
    });
    const text = (getPartiesTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('unknown');
  });
});
