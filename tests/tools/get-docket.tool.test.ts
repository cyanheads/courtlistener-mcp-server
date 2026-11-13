/**
 * @fileoverview Tests for the get-docket tool.
 * @module tests/tools/get-docket.tool.test
 */

import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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
  it.each([
    ['', false, 'unavailable'],
    [null, true, 'not_extracted'],
    [undefined, undefined, 'unknown'],
    [' ', false, 'available'],
    ['', true, 'not_extracted'],
    [null, false, 'unavailable'],
    [undefined, true, 'not_extracted'],
    [undefined, false, 'unavailable'],
  ] as const)(
    'preserves text %j and availability %j as %s',
    async (plain_text, is_available, text_status) => {
      const docket = structuredClone(baseDocket);
      Object.assign(docket.docket_entries[0]!, { docket: 8000 });
      const document = docket.docket_entries[0]!.recap_documents[0]!;
      Object.assign(document, { plain_text, is_available });
      mockSvc.getDocket = vi.fn().mockResolvedValue(docket);
      const contract = await runToolContract(getDocketTool, {
        docket_id: 8000,
        document_ids: [90001],
      });
      expect(contract.structuredContent).toMatchObject({
        selected_documents: [
          {
            text_status,
            is_available: is_available ?? null,
            ...(plain_text !== undefined ? { plain_text } : {}),
          },
        ],
      });
      expect((contract.content[0] as { text: string }).text).toContain(
        text_status === 'not_extracted' ? 'not\\_extracted' : text_status,
      );
    },
  );

  it('reports page selection and unverified ownership with truthful recovery on both surfaces', async () => {
    mockSvc.getDocket = vi.fn().mockResolvedValue(baseDocket);
    const missing = await runToolContract(getDocketTool, {
      docket_id: 8000,
      entries_page: 3,
      document_ids: [123],
    });
    expect(missing.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'document_not_on_page',
          recovery: { hint: expect.stringContaining('entries_page') },
        },
      },
    });
    expect(JSON.stringify(missing.content)).toContain('entries_page');
    expect(JSON.stringify(missing.content)).not.toContain('does not exist');
    const unverified = await runToolContract(getDocketTool, {
      docket_id: 8000,
      document_ids: [90001],
    });
    expect(unverified.structuredContent).toMatchObject({
      error: { data: { reason: 'document_ownership_unverified' } },
    });
    expect(JSON.stringify(unverified.content)).toContain('explicitly belongs');
    expect(mockSvc.getDocket).toHaveBeenCalledTimes(2);
  });

  it('reconstructs Unicode and oversized metadata exactly with page-bound repeatable cursors', async () => {
    const docket = structuredClone(baseDocket);
    const source = '😀\r\n<&>\\ * source '.repeat(5000);
    Object.assign(docket.docket_entries[0]!, { docket: 8000 });
    Object.assign(docket.docket_entries[0]!.recap_documents[0]!, {
      plain_text: source,
      description: 'large 😀'.repeat(4000),
      absolute_url: '/docket/8000/1/source/',
    });
    mockSvc.getDocket = vi.fn().mockResolvedValue(docket);
    const call = (cursor?: string, extra = {}, tenantId = 'default') =>
      getDocketTool.handler(
        getDocketTool.input.parse({
          docket_id: 8000,
          document_ids: [90001, 90001],
          cursor,
          ...extra,
        }),
        createMockContext({ errors: getDocketTool.errors, tenantId }),
      );
    const first = await call();
    expect(first.kind).toBe('outline');
    const token = first.retrieval!.next_cursor!;
    expect(await call(token)).toEqual(await call(token));
    await expect(call(token, { entries_page: 2 })).rejects.toMatchObject({
      data: { reason: 'invalid_cursor' },
    });
    await expect(call(token, { document_ids: [2] })).rejects.toMatchObject({
      data: { reason: 'invalid_cursor' },
    });
    let page = first;
    let text = '';
    let description = '';
    let pages = 0;
    for (;;) {
      const parsed = getDocketTool.output.parse(page);
      expect(Buffer.byteLength(JSON.stringify(parsed))).toBeLessThanOrEqual(24000);
      expect(Buffer.byteLength(JSON.stringify(getDocketTool.format!(parsed)))).toBeLessThanOrEqual(
        24000,
      );
      for (const chunk of page.retrieval?.text_chunks ?? []) {
        if (chunk.path === '/selected_documents/0/plain_text') text += chunk.text;
        if (chunk.path === '/selected_documents/0/description') description += chunk.text;
      }
      const cursor = page.retrieval?.next_cursor;
      if (!cursor) break;
      page = await call(cursor, { document_ids: [90001] });
      expect(++pages).toBeLessThan(100);
    }
    expect(text).toBe(source);
    expect(description).toBe('large 😀'.repeat(4000));
    Object.assign(docket.docket_entries[0]!.recap_documents[0]!, {
      plain_text: `${source}changed`,
    });
    await expect(call(token, {}, 'cold-replay')).rejects.toMatchObject({
      data: { reason: 'stale_cursor' },
    });
  });

  it('rejects invalid selector shapes and cursor without selection', async () => {
    for (const document_ids of [[], [0], [-1], [1.5], ['1']])
      expect(() => getDocketTool.input.parse({ docket_id: 8000, document_ids })).toThrow();
    const result = await runToolContract(getDocketTool, { docket_id: 8000, cursor: 'token' });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'selection_required' } },
    });
    expect(mockSvc.getDocket).not.toHaveBeenCalled();
  });
  it('selects embedded document text without confusing text and file availability', async () => {
    const docket = structuredClone(baseDocket);
    Object.assign(docket.docket_entries[0]!, {
      docket: 'https://www.courtlistener.com/api/rest/v4/dockets/8000/',
    });
    Object.assign(docket.docket_entries[0]!.recap_documents[0]!, {
      plain_text: 'Exact 😀\r\n<source> & *text*',
      is_available: false,
    });
    mockSvc.getDocket = vi.fn().mockResolvedValue(docket);
    const result = await getDocketTool.handler(
      getDocketTool.input.parse({ docket_id: 8000, document_ids: [90001] }),
      createMockContext({ errors: getDocketTool.errors }),
    );
    expect(result).toMatchObject({
      kind: 'full',
      selected_documents: [
        {
          id: 90001,
          plain_text: 'Exact 😀\r\n<source> & *text*',
          text_status: 'available',
          is_available: false,
        },
      ],
    });
    expect(JSON.stringify(getDocketTool.format!(getDocketTool.output.parse(result)))).toContain(
      'available',
    );
    expect(
      (getDocketTool.format!(getDocketTool.output.parse(result))[0] as { text: string }).text,
    ).toContain('Exact 😀\r\n&lt;source&gt; &amp; \\*text\\*');
  });
  it('keeps default listing free of nested filing text', async () => {
    const docket = structuredClone(baseDocket);
    Object.assign(docket.docket_entries[0]!.recap_documents[0]!, {
      plain_text: 'paid source text',
    });
    mockSvc.getDocket = vi.fn().mockResolvedValue(docket);
    const result = await getDocketTool.handler(
      getDocketTool.input.parse({ docket_id: 8000 }),
      createMockContext({ errors: getDocketTool.errors }),
    );
    expect(JSON.stringify(result)).not.toContain('paid source text');
    expect(JSON.stringify(getDocketTool.format!(getDocketTool.output.parse(result)))).not.toContain(
      'paid source text',
    );
    expect(result.next_cursor).toBeNull();
  });
  it('returns full docket metadata and entries', async () => {
    mockSvc.getDocket = vi.fn().mockResolvedValue(baseDocket);
    const ctx = createMockContext({ errors: getDocketTool.errors });
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
    expect(result.entries![0]!.id).toBe(50001);
    expect(result.entries![0]!.documents[0]!.id).toBe(90001);
    expect(result.entries![0]!.documents[0]!.attachment_number).toBeNull();
    // document_number is preserved as the string the upstream sends — not coerced (#23)
    expect(result.entries![0]!.documents[0]!.document_number).toBe('1');
    // relative filepath_local is normalized to a directly fetchable storage URL (#26)
    expect(result.entries![0]!.documents[0]!.filepath_local).toBe(
      'https://storage.courtlistener.com/recap/gov.uscourts.cand.123/doc1.pdf',
    );
    // the real upstream types validate against the declared output schema
    expect(() => getDocketTool.output.parse(result)).not.toThrow();
  });

  it('returns valid linked IDs and case metadata on both listing surfaces', async () => {
    mockSvc.getDocket = vi.fn().mockResolvedValue({
      ...baseDocket,
      clusters: [
        '/api/rest/v4/clusters/32/',
        '/api/rest/v4/documents/9/',
        '/api/rest/v4/clusters/12/',
      ],
      audio_files: ['/api/rest/v4/audio/107253/'],
      date_argued: '2026-10-29',
      nature_of_suit: '',
      appeal_from_str: 'Southern District',
      date_last_filing: '2025-08-28',
    });
    const wire = await runToolContract(getDocketTool, { docket_id: 8000 });
    expect(wire.structuredContent).toMatchObject({
      cluster_ids: [32, 12],
      audio_ids: [107253],
      date_argued: '2026-10-29',
      suit_nature: null,
      appeal_from: 'Southern District',
      date_last_filing: '2025-08-28',
    });
    expect(wire.content[0]).toMatchObject({
      text: expect.stringContaining('**Opinion cluster IDs:** 32, 12'),
    });
    expect(wire.content[0]).toMatchObject({
      text: expect.stringContaining('**Audio IDs:** 107253'),
    });
    expect(mockSvc.getDocket).toHaveBeenCalledTimes(1);
  });

  it('resolves a known court_id to its display name', async () => {
    mockSvc.getDocket = vi.fn().mockResolvedValue({
      ...baseDocket,
      court_id: 'scotus',
      court: 'https://www.courtlistener.com/api/rest/v4/courts/scotus/',
    });
    const ctx = createMockContext({ errors: getDocketTool.errors });
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
    const ctx = createMockContext({ errors: getDocketTool.errors });
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
    const ctx = createMockContext({ errors: getDocketTool.errors });
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
    const ctx = createMockContext({ errors: getDocketTool.errors });
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
    const ctx = createMockContext({ errors: getDocketTool.errors });
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
              is_available: false,
              page_count: 3,
              filepath_local: 'https://storage.courtlistener.com/recap/already-absolute.pdf',
            },
          ],
        },
      ],
    });
    const ctx = createMockContext({ errors: getDocketTool.errors });
    const result = await getDocketTool.handler(getDocketTool.input.parse({ docket_id: 8000 }), ctx);
    expect(result.entries![0]!.documents[0]!.document_number).toBe('70-1');
    // an already-absolute URL is passed through, never double-prefixed
    expect(result.entries![0]!.documents[0]!.filepath_local).toBe(
      'https://storage.courtlistener.com/recap/already-absolute.pdf',
    );
    expect(() => getDocketTool.output.parse(result)).not.toThrow();
    expect(getDocketTool.format?.(getDocketTool.output.parse(result))[0]).toMatchObject({
      text: expect.stringContaining(
        '[requires PACER] [RECAP file](<https://storage.courtlistener.com/recap/already-absolute.pdf>)',
      ),
    });
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
