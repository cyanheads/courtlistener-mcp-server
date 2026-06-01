/**
 * @fileoverview Tests for the get-docket tool.
 * @module tests/tools/get-docket.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDocketTool } from '@/mcp-server/tools/definitions/get-docket.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';
import type { Docket } from '@/services/courtlistener/types.js';

const mockSvc = {
  getDocket: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

const baseDocket: Docket = {
  id: 8000,
  case_name: 'Apple Inc. v. Samsung',
  case_name_full: 'Apple Incorporated v. Samsung Electronics Co., Ltd.',
  // Upstream returns court as a resource URI; the handler resolves it via court_id.
  court: 'https://www.courtlistener.com/api/rest/v4/courts/cand/',
  court_id: 'cand',
  date_filed: '2011-04-15',
  date_terminated: '2018-06-27',
  docket_number: '11-cv-01846',
  pacer_case_id: 'pacer123',
  assigned_to_str: 'Judge Koh',
  referred_to_str: null,
  cause: 'Patent Infringement',
  jury_demand: 'Both',
  jurisdiction_type: 'Federal Question',
  docket_entries: [
    {
      id: 50001,
      entry_number: 1,
      date_filed: '2011-04-15',
      description: 'Complaint filed',
      recap_documents: [
        {
          id: 90001,
          document_number: 1,
          attachment_number: null,
          description: 'Complaint',
          is_available: true,
          page_count: 42,
          filepath_local: 'https://storage.courtlistener.com/recap/gov.uscourts.cand.123/doc1.pdf',
        },
      ],
    },
  ],
};

describe('getDocketTool', () => {
  it('returns full docket metadata and entries', async () => {
    mockSvc.getDocket = vi.fn().mockResolvedValue(baseDocket);
    const ctx = createMockContext();
    const input = getDocketTool.input.parse({ docket_id: 8000 });
    const result = await getDocketTool.handler(input, ctx);

    expect(result.docket_id).toBe(8000);
    expect(result.case_name).toBe('Apple Inc. v. Samsung');
    expect(result.case_name_full).toBe('Apple Incorporated v. Samsung Electronics Co., Ltd.');
    expect(result.jury_demand).toBe('Both');
    // court is resolved from court_id, never the raw URI — unmapped courts fall back to the id
    expect(result.court).toBe('cand');
    expect(result.court).not.toContain('http');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe(50001);
    expect(result.entries[0].documents[0].id).toBe(90001);
    expect(result.entries[0].documents[0].attachment_number).toBeNull();
  });

  it('resolves a known court_id to its display name', async () => {
    mockSvc.getDocket = vi.fn().mockResolvedValue({
      ...baseDocket,
      court_id: 'scotus',
      court: 'https://www.courtlistener.com/api/rest/v4/courts/scotus/',
    });
    const ctx = createMockContext();
    const input = getDocketTool.input.parse({ docket_id: 8000 });
    const result = await getDocketTool.handler(input, ctx);
    expect(result.court).toBe('Supreme Court of the United States');
    expect(result.court_id).toBe('scotus');
  });

  it('throws not_found for missing docket', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockSvc.getDocket = vi
      .fn()
      .mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'not found'));
    const ctx = createMockContext({ errors: getDocketTool.errors });
    const input = getDocketTool.input.parse({ docket_id: 99999 });
    await expect(getDocketTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('passes entries_page_size to service', async () => {
    mockSvc.getDocket = vi.fn().mockResolvedValue(baseDocket);
    const ctx = createMockContext();
    const input = getDocketTool.input.parse({ docket_id: 8000, entries_page_size: 50 });
    await getDocketTool.handler(input, ctx);
    expect(mockSvc.getDocket).toHaveBeenCalledWith(8000, 50, ctx);
  });

  it('formats output with case_name_full, jury_demand, and entry/doc IDs', () => {
    const output = getDocketTool.output.parse({
      docket_id: 8000,
      case_name: 'Apple v. Samsung',
      case_name_full: 'Apple Incorporated v. Samsung Electronics Co., Ltd.',
      court: 'N.D. Cal.',
      court_id: 'cand',
      date_filed: '2011-04-15',
      date_terminated: '2018-06-27',
      docket_number: '11-cv-01846',
      pacer_case_id: 'pacer123',
      assigned_to: 'Judge Koh',
      referred_to: null,
      cause: 'Patent Infringement',
      jury_demand: 'Both',
      jurisdiction_type: 'Federal Question',
      total_entries: 1,
      entries: [
        {
          id: 50001,
          entry_number: 1,
          date_filed: '2011-04-15',
          description: 'Complaint filed',
          documents: [
            {
              id: 90001,
              document_number: 1,
              attachment_number: 2,
              description: 'Complaint',
              is_available: true,
              page_count: 42,
              filepath_local: 'https://storage.courtlistener.com/recap/doc1.pdf',
            },
          ],
        },
      ],
    });
    const blocks = getDocketTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('8000');
    expect(text).toContain('Apple v. Samsung');
    // case_name_full must be rendered
    expect(text).toContain('Apple Incorporated v. Samsung Electronics Co., Ltd.');
    // jury_demand must be rendered
    expect(text).toContain('Both');
    // entry id must be rendered
    expect(text).toContain('50001');
    // document id must be rendered
    expect(text).toContain('90001');
    // attachment_number must be rendered
    expect(text).toContain('2');
  });
});
