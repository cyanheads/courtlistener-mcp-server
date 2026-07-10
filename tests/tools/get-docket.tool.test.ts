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
          // /docket-entries/ returns document_number as a string and filepath_local as a relative path.
          document_number: '1',
          attachment_number: null,
          description: 'Complaint',
          is_available: true,
          page_count: 42,
          filepath_local: 'recap/gov.uscourts.cand.123/doc1.pdf',
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
    // court is resolved from court_id to the full name, never the raw URI (#27 —
    // district/bankruptcy/state courts now resolve, not just federal appellate)
    expect(result.court).toBe('District Court, N.D. California');
    expect(result.court).not.toContain('http');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].id).toBe(50001);
    expect(result.entries[0].documents[0].id).toBe(90001);
    expect(result.entries[0].documents[0].attachment_number).toBeNull();
    // document_number is preserved as the string the upstream sends — not coerced (#23)
    expect(result.entries[0].documents[0].document_number).toBe('1');
    // relative filepath_local is normalized to a directly fetchable storage URL (#26)
    expect(result.entries[0].documents[0].filepath_local).toBe(
      'https://storage.courtlistener.com/recap/gov.uscourts.cand.123/doc1.pdf',
    );
    // the real upstream types validate against the declared output schema
    expect(() => getDocketTool.output.parse(result)).not.toThrow();
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

  it('threads entries_page and entries_page_size through to the service', async () => {
    mockSvc.getDocket = vi.fn().mockResolvedValue(baseDocket);
    const ctx = createMockContext();
    const input = getDocketTool.input.parse({
      docket_id: 8000,
      entries_page: 3,
      entries_page_size: 50,
    });
    await getDocketTool.handler(input, ctx);
    // Signature is getDocket(docketId, entriesPageSize, entriesPage, ctx) — page-size then page.
    expect(mockSvc.getDocket).toHaveBeenCalledWith(8000, 50, 3, ctx);
  });

  it('defaults entries_page to 1 when omitted', async () => {
    mockSvc.getDocket = vi.fn().mockResolvedValue(baseDocket);
    const ctx = createMockContext();
    const input = getDocketTool.input.parse({ docket_id: 8000 });
    await getDocketTool.handler(input, ctx);
    expect(mockSvc.getDocket).toHaveBeenCalledWith(8000, 20, 1, ctx);
  });

  it('surfaces next_cursor and echoes entries_page when more entry pages exist', async () => {
    mockSvc.getDocket = vi.fn().mockResolvedValue({
      ...baseDocket,
      docket_entries_count: 153,
      docket_entries_next_page: '3',
    });
    const ctx = createMockContext();
    const input = getDocketTool.input.parse({ docket_id: 8000, entries_page: 2 });
    const result = await getDocketTool.handler(input, ctx);
    expect(result.entries_page).toBe(2);
    // next page is surfaced as a stringified page number (page-paginated, not a cursor token)
    expect(result.next_cursor).toBe('3');
    expect(result.total_entries).toBe(153);
    expect(() => getDocketTool.output.parse(result)).not.toThrow();
  });

  it('returns a null next_cursor on the last entry page', async () => {
    mockSvc.getDocket = vi.fn().mockResolvedValue({
      ...baseDocket,
      docket_entries_next_page: null,
    });
    const ctx = createMockContext();
    const input = getDocketTool.input.parse({ docket_id: 8000 });
    const result = await getDocketTool.handler(input, ctx);
    expect(result.next_cursor).toBeNull();
    expect(() => getDocketTool.output.parse(result)).not.toThrow();
  });

  it('preserves a non-integer document_number and leaves an already-absolute filepath_local untouched', async () => {
    mockSvc.getDocket = vi.fn().mockResolvedValue({
      ...baseDocket,
      docket_entries: [
        {
          id: 50002,
          entry_number: 70,
          date_filed: '2012-01-01',
          description: 'Attachment',
          recap_documents: [
            {
              id: 90002,
              document_number: '70-1', // PACER attachment numbering — not integer-parseable
              attachment_number: 1,
              description: 'Exhibit A',
              is_available: true,
              page_count: 3,
              filepath_local: 'https://storage.courtlistener.com/recap/already-absolute.pdf',
            },
          ],
        },
      ],
    });
    const ctx = createMockContext();
    const result = await getDocketTool.handler(getDocketTool.input.parse({ docket_id: 8000 }), ctx);
    expect(result.entries[0].documents[0].document_number).toBe('70-1');
    // an already-absolute URL is passed through, never double-prefixed
    expect(result.entries[0].documents[0].filepath_local).toBe(
      'https://storage.courtlistener.com/recap/already-absolute.pdf',
    );
    expect(() => getDocketTool.output.parse(result)).not.toThrow();
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
      entries_page: 1,
      next_cursor: null,
      entries: [
        {
          id: 50001,
          entry_number: 1,
          date_filed: '2011-04-15',
          description: 'Complaint filed',
          documents: [
            {
              id: 90001,
              document_number: '1',
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

  it('format shows the continuation hint when next_cursor is set', () => {
    const output = getDocketTool.output.parse({
      docket_id: 8000,
      case_name: 'Apple v. Samsung',
      case_name_full: '',
      court: 'N.D. Cal.',
      court_id: 'cand',
      date_filed: '2011-04-15',
      date_terminated: null,
      docket_number: '11-cv-01846',
      pacer_case_id: null,
      assigned_to: null,
      referred_to: null,
      cause: '',
      jury_demand: '',
      jurisdiction_type: '',
      total_entries: 153,
      entries_page: 1,
      next_cursor: '2',
      entries: [],
    });
    const text = (getDocketTool.format!(output)[0] as { text: string }).text;
    // page number and next-page continuation hint must both render
    expect(text).toContain('**Page:** 1');
    expect(text).toContain('entries_page=2');
  });
});
