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
      role_code: 1,
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
      role_code: 1,
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
    expect(result.page).toBe(1);
    expect(result.next_cursor).toBeNull();
    expect(result.parties).toHaveLength(2);

    const plaintiff = result.parties[0];
    expect(plaintiff.id).toBe(1001);
    expect(plaintiff.name).toBe('Apple Inc.');
    expect(plaintiff.role).toBe('Plaintiff');
    expect(plaintiff.attorneys).toHaveLength(1);
    expect(plaintiff.attorneys[0].attorney_id).toBe(5001);
    expect(plaintiff.attorneys[0].name).toBe('Harold Lee');
    expect(plaintiff.attorneys[0].role_code).toBe(1);
  });

  it('passes docket_id, page, and page_size to service', async () => {
    mockSvc.getParties = vi.fn().mockResolvedValue({ count: 0, next_cursor: null, parties: [] });
    const ctx = createMockContext();
    const input = getPartiesTool.input.parse({ docket_id: 9999, page: 2, page_size: 5 });
    await getPartiesTool.handler(input, ctx);
    expect(mockSvc.getParties).toHaveBeenCalledWith(9999, 2, 5, ctx);
  });

  it('surfaces next_cursor when more pages exist', async () => {
    mockSvc.getParties = vi.fn().mockResolvedValue({
      count: 20,
      next_cursor: 'abc123',
      parties: [basePlaintiff],
    });
    const ctx = createMockContext();
    const input = getPartiesTool.input.parse({ docket_id: 8000, page_size: 1 });
    const result = await getPartiesTool.handler(input, ctx);
    expect(result.next_cursor).toBe('abc123');
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
      page: 1,
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
              role_code: 1,
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
    // attorney info must be rendered
    expect(text).toContain('Harold Lee');
    expect(text).toContain('5001');
    // extra_info must be rendered
    expect(text).toContain('South Korean Corporation');
    // party id must be rendered
    expect(text).toContain('1001');
    expect(text).toContain('1002');
  });

  it('format shows next-page hint when next_cursor is set', () => {
    const output = getPartiesTool.output.parse({
      docket_id: 8000,
      total_parties: 20,
      page: 1,
      next_cursor: 'xyz',
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
    expect(text).toContain('page=2');
  });
});
