/**
 * @fileoverview Tests for the get-opinion tool.
 * @module tests/tools/get-opinion.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOpinionTool } from '@/mcp-server/tools/definitions/get-opinion.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';
import { retrieve } from '@/services/courtlistener/retrieval.js';
import type { OpinionCluster } from '@/services/courtlistener/types.js';
import { captureError } from '../helpers/capture-error.js';

const mockSvc = {
  getOpinionCluster: vi.fn(),
  getDocketSummary: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
  // Default: linked docket backfills court_id and docket_number (the cluster endpoint omits both).
  mockSvc.getDocketSummary = vi
    .fn()
    .mockResolvedValue({ court_id: 'scotus', docket_number: '70-18', case_name: 'Roe v. Wade' });
});

// The /clusters/{id}/ endpoint returns case_name (snake_case) but omits court_id and docket_number.
const baseCluster: OpinionCluster = {
  id: 100,
  case_name: 'Roe v. Wade',
  case_name_full: 'Roe v. Wade (Full)',
  court: '',
  date_filed: '1973-01-22',
  docket: 'https://www.courtlistener.com/api/rest/v4/dockets/5000/',
  docket_id: 5000,
  judges: 'Blackmun',
  // volume is a TextField upstream — a string, matching the raw /clusters/ payload.
  citations: [{ volume: '410', reporter: 'U.S.', page: '113', type: 1 }],
  citation_count: 10000,
  precedential_status: 'Published',
  syllabus: 'The right of privacy extends to reproductive choices.',
  posture: 'Appeal from district court',
  sub_opinions: [
    {
      // /opinions/ serves the stored code; the search API serves the expanded label.
      id: 1000,
      type: '020lead',
      author_id: 42,
      per_curiam: false,
      html: '<p>Opinion text</p>',
      plain_text: 'Opinion plain text',
      opinions_cited: ['/api/rest/v4/opinions/999/'],
      download_url: 'https://example.com/opinion.pdf',
    },
  ],
};

describe('getOpinionTool', () => {
  it.each(['scotus', undefined])(
    'keeps canonical court values consistent with retrieval chunks (source ID=%s)',
    async (court_id) => {
      const cluster = {
        id: 1,
        docket_id: 10,
        court: 'Original court '.repeat(4000),
        court_id,
        sub_opinions: [{ id: 2, plain_text: 'body'.repeat(10000) }],
      };
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(cluster);
      mockSvc.getDocketSummary = vi
        .fn()
        .mockResolvedValue({ court_id: 'scotus', docket_number: '1' });
      let cursor: string | undefined;
      let body = '';
      let firstCursor: string | undefined;
      do {
        const wire = await runToolContract(getOpinionTool, { cluster_id: 1, cursor });
        expect(wire.isError, JSON.stringify(wire)).not.toBe(true);
        const page = getOpinionTool.output.parse(wire.structuredContent);
        expect(page.court).toBe('Supreme Court of the United States');
        expect(page.retrieval?.text_chunks.some((chunk) => chunk.path === '/court')).not.toBe(true);
        expect(
          page.enrichment_retrieval?.text_chunks.some((chunk) => chunk.path === '/court'),
        ).not.toBe(true);
        expect(Buffer.byteLength(JSON.stringify(wire.structuredContent))).toBeLessThanOrEqual(
          24_000,
        );
        expect(Buffer.byteLength(JSON.stringify(wire.content))).toBeLessThanOrEqual(24_000);
        for (const chunk of page.retrieval?.text_chunks ?? []) {
          if (chunk.path !== '/opinions/0/plain_text') continue;
          const range = page.retrieval!.ranges.find(
            (range) => range.path === chunk.path && range.unit === 'code_points',
          )!;
          expect(range.start).toBe(Array.from(body).length);
          body += chunk.text;
        }
        cursor = page.retrieval?.next_cursor ?? undefined;
        firstCursor ??= cursor;
      } while (cursor);
      expect(body).toBe('body'.repeat(10000));
      cluster.court = 'Changed raw court';
      const changed = await runToolContract(getOpinionTool, { cluster_id: 1, cursor: firstCursor });
      expect(changed).toMatchObject({
        isError: true,
        structuredContent: { error: { data: { reason: 'stale_cursor' } } },
      });
    },
  );

  it('continues a version-one cursor using its original enriched layout', async () => {
    const plainText = 'legacy 😀'.repeat(8000);
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue({
      ...baseCluster,
      sub_opinions: [{ id: 1000, plain_text: plainText }],
    });
    const oldView = {
      cluster_id: 100,
      variants_completion: undefined,
      docket_enrichment: { status: 'resolved' },
      case_name: baseCluster.case_name,
      case_name_full: baseCluster.case_name_full,
      court: 'Supreme Court of the United States',
      court_id: 'scotus',
      date_filed: baseCluster.date_filed,
      docket_id: 5000,
      docket_number: '70-18',
      judges: baseCluster.judges,
      citations: ['410 U.S. 113'],
      cite_count: 10000,
      precedential_status: 'Published',
      syllabus: baseCluster.syllabus,
      posture: baseCluster.posture,
      opinions: [
        {
          id: 1000,
          type: '',
          type_label: '',
          author_id: null,
          per_curiam: false,
          html_text: '',
          plain_text: plainText,
          cites: [],
          download_url: null,
        },
      ],
    };
    const first = retrieve({
      tool: 'opinion',
      id: 100,
      view: oldView,
      groups: [{ name: 'opinion_1000', value: oldView.opinions[0] }],
      required: [
        'cluster_id',
        'docket_id',
        'cite_count',
        'variants_completion',
        'docket_enrichment',
      ],
      finalize: (value) => {
        const parsed = getOpinionTool.output.parse(value);
        return { structuredContent: parsed, content: getOpinionTool.format!(parsed) };
      },
    });
    const cursor = first.retrieval!.next_cursor!;
    expect(JSON.parse(Buffer.from(cursor, 'base64url').toString()).v).toBe(1);
    const wire = await runToolContract(getOpinionTool, { cluster_id: 100, cursor });
    expect(wire.isError, JSON.stringify(wire)).not.toBe(true);
    const page = getOpinionTool.output.parse(wire.structuredContent);
    expect(page.retrieval!.ranges).toContainEqual(
      expect.objectContaining({ path: '/opinions/0/plain_text', start: 0 }),
    );
    expect(page.retrieval!.text_chunks[0]?.text).toBe(
      plainText.slice(0, page.retrieval!.text_chunks[0]!.text.length),
    );
  });

  it.each(['court', 'completion', 'text'] as const)(
    'still rejects changed original %s source on both surfaces',
    async (mutation) => {
      const cluster = {
        ...baseCluster,
        court: 'Original court',
        variants_completion: { complete: false, next_cursor: 'remaining' },
        sub_opinions: [{ id: 1000, plain_text: 'source'.repeat(10000) }],
      };
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(cluster);
      const first = await runToolContract(getOpinionTool, { cluster_id: 100 });
      const cursor = getOpinionTool.output.parse(first.structuredContent).retrieval!.next_cursor!;
      if (mutation === 'court') cluster.court = 'Changed original court';
      if (mutation === 'completion') cluster.variants_completion.complete = true;
      if (mutation === 'text') cluster.sub_opinions[0]!.plain_text = 'changed';
      const wire = await runToolContract(getOpinionTool, { cluster_id: 100, cursor });
      expect(wire).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            data: {
              reason: 'stale_cursor',
              recovery: { hint: expect.stringContaining('Restart') },
            },
          },
        },
      });
      expect(
        wire.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
      ).toContain('stale_cursor');
    },
  );

  it('rejects malformed enrichment cursors before upstream I/O', async () => {
    const wire = await runToolContract(getOpinionTool, { cluster_id: 100, enrichment_cursor: '!' });
    expect(wire).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'invalid_cursor' } } },
    });
    expect(mockSvc.getOpinionCluster).not.toHaveBeenCalled();
    expect(
      wire.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    ).toContain('invalid_cursor');
  });

  it('marks metadata-only overflow partial even when the primary selection is empty', async () => {
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue({ ...baseCluster, sub_opinions: [] });
    mockSvc.getDocketSummary = vi
      .fn()
      .mockResolvedValue({ court_id: 'scotus', docket_number: 'metadata'.repeat(10000) });
    const wire = await runToolContract(getOpinionTool, { cluster_id: 100 });
    expect(wire.isError).not.toBe(true);
    expect(wire.structuredContent).toMatchObject({
      kind: 'page',
      opinions: [],
      retrieval: { next_cursor: null },
      enrichment_retrieval: { next_cursor: expect.any(String) },
    });
  });

  it('rejects a past-end enrichment position without discarding the valid primary position', async () => {
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue({
      ...baseCluster,
      sub_opinions: [{ id: 1000, plain_text: 'primary'.repeat(10000) }],
    });
    mockSvc.getDocketSummary = vi
      .fn()
      .mockResolvedValue({ court_id: 'scotus', docket_number: 'large'.repeat(10000) });
    const first = getOpinionTool.output.parse(
      (await runToolContract(getOpinionTool, { cluster_id: 100 })).structuredContent,
    );
    const decoded = JSON.parse(
      Buffer.from(first.enrichment_retrieval!.next_cursor!, 'base64url').toString(),
    );
    decoded.index = 9999;
    const enrichment_cursor = Buffer.from(JSON.stringify(decoded)).toString('base64url');
    const wire = await runToolContract(getOpinionTool, {
      cluster_id: 100,
      cursor: first.retrieval!.next_cursor!,
      enrichment_cursor,
    });
    expect(wire).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'invalid_cursor' } } },
    });
    expect(
      wire.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    ).toContain('invalid_cursor');
    const resumed = await runToolContract(getOpinionTool, {
      cluster_id: 100,
      cursor: first.retrieval!.next_cursor!,
    });
    expect(resumed.isError).not.toBe(true);
  });
  it('characterizes primary source court precedence and small docket backfill', async () => {
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue({
      ...baseCluster,
      court_id: 'ca9',
      docket_number: 'source-number',
    });
    const wire = await runToolContract(getOpinionTool, { cluster_id: 100 });
    expect(wire.isError).not.toBe(true);
    expect(wire.structuredContent).toMatchObject({
      kind: 'full',
      court_id: 'ca9',
      docket_number: 'source-number',
      docket_enrichment: { status: 'resolved' },
    });
  });

  it.each([true, false])(
    'continues primary text across docket outcome changes (resolved first=%s)',
    async (resolvedFirst) => {
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue({
        ...baseCluster,
        sub_opinions: [{ id: 1000, plain_text: 'primary 😀'.repeat(8000) }],
      });
      const summary = vi.fn();
      const success = { court_id: 'scotus', docket_number: 'backfill' };
      const failure = new McpError(JsonRpcErrorCode.NotFound, 'Unavailable');
      if (resolvedFirst) summary.mockResolvedValueOnce(success).mockRejectedValue(failure);
      else summary.mockRejectedValueOnce(failure).mockResolvedValue(success);
      mockSvc.getDocketSummary = summary;
      const first = await runToolContract(getOpinionTool, { cluster_id: 100 });
      const cursor = (first.structuredContent as { retrieval: { next_cursor: string } }).retrieval
        .next_cursor;
      const next = await runToolContract(getOpinionTool, { cluster_id: 100, cursor });
      expect(next.isError, JSON.stringify(next)).not.toBe(true);
      expect(next.structuredContent).toMatchObject({
        docket_enrichment: { status: resolvedFirst ? 'lookup_failed' : 'resolved' },
      });
    },
  );

  it('carries capped completion through selection and text output', async () => {
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue({
      ...baseCluster,
      variants_completion: { complete: false, next_cursor: 'variant-next' },
    });
    const result = await getOpinionTool.handler(
      getOpinionTool.input.parse({ cluster_id: 100, sections: ['opinion_1000'] }),
      createMockContext({ errors: getOpinionTool.errors }),
    );
    expect(result.variants_completion).toEqual({ complete: false, next_cursor: 'variant-next' });
    expect(
      getOpinionTool.format!(result)
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n'),
    ).toContain('variant\\-next');
    const response = await runToolContract(getOpinionTool, { cluster_id: 100 });
    expect(response.structuredContent).toMatchObject({
      variants_completion: { complete: false, next_cursor: 'variant-next' },
      docket_enrichment: { status: 'resolved' },
    });
    expect(
      response.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    ).toContain('upstream variant cursor=variant\\-next');
  });

  it.each([
    [null, 'resolved', 'resolved'],
    [{ court_id: '', docket_number: '' }, 'source_fields_absent', 'source\\_fields\\_absent'],
  ] as const)('reports successful docket lookup state %s', async (summary, status, displayed) => {
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(baseCluster);
    if (summary) mockSvc.getDocketSummary = vi.fn().mockResolvedValue(summary);
    const result = await getOpinionTool.handler(
      getOpinionTool.input.parse({ cluster_id: 100 }),
      createMockContext({ errors: getOpinionTool.errors }),
    );
    expect(result.docket_enrichment?.status).toBe(status);
    expect(
      getOpinionTool.format!(result)
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n'),
    ).toContain(displayed);
  });

  it('reports absent docket links without requesting a summary', async () => {
    mockSvc.getOpinionCluster = vi
      .fn()
      .mockResolvedValue({ ...baseCluster, docket_id: 0, docket: '' });
    const result = await getOpinionTool.handler(
      getOpinionTool.input.parse({ cluster_id: 100 }),
      createMockContext({ errors: getOpinionTool.errors }),
    );
    expect(result.docket_enrichment?.status).toBe('not_linked');
    expect(mockSvc.getDocketSummary).not.toHaveBeenCalled();
  });

  it.each([JsonRpcErrorCode.NotFound, JsonRpcErrorCode.ServiceUnavailable])(
    'sanitizes docket failure %s and preserves source court',
    async (code) => {
      mockSvc.getOpinionCluster = vi
        .fn()
        .mockResolvedValue({ ...baseCluster, court: 'Source court' });
      mockSvc.getDocketSummary = vi
        .fn()
        .mockRejectedValue(new McpError(code, 'credential=PRIVATE', { body: 'PRIVATE' }));
      const result = await getOpinionTool.handler(
        getOpinionTool.input.parse({ cluster_id: 100 }),
        createMockContext({ errors: getOpinionTool.errors }),
      );
      expect(result.court).toBe('Source court');
      expect(result.docket_enrichment).toEqual({
        status: 'lookup_failed',
        error_code: code,
        reason: code === JsonRpcErrorCode.NotFound ? 'not_found' : 'lookup_failed',
      });
      expect(JSON.stringify([result, getOpinionTool.format!(result)])).not.toContain('PRIVATE');
    },
  );

  it('propagates cancellation from optional docket lookup', async () => {
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(baseCluster);
    const failure = new McpError(JsonRpcErrorCode.RequestCancelled, 'Cancelled');
    mockSvc.getDocketSummary = vi.fn().mockRejectedValue(failure);
    await expect(
      getOpinionTool.handler(
        getOpinionTool.input.parse({ cluster_id: 100 }),
        createMockContext({ errors: getOpinionTool.errors }),
      ),
    ).rejects.toBe(failure);
  });
  it('returns full cluster metadata for valid cluster_id', async () => {
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(baseCluster);
    const ctx = createMockContext({ errors: getOpinionTool.errors });
    const input = getOpinionTool.input.parse({ cluster_id: 100 });
    const result = await getOpinionTool.handler(input, ctx);

    expect(result.kind).toBe('full');
    expect(result.cluster_id).toBe(100);
    expect(result.case_name).toBe('Roe v. Wade');
    expect(result.case_name_full).toBe('Roe v. Wade (Full)');
    // court_id and docket_number are backfilled from the linked docket; court resolved via the map
    expect(result.court_id).toBe('scotus');
    expect(result.court).toBe('Supreme Court of the United States');
    expect(result.docket_number).toBe('70-18');
    expect(result.citations).toEqual(['410 U.S. 113']);
    expect(result.cite_count).toBe(10000);
    expect(result.opinions).toHaveLength(1);
    expect(result.opinions?.[0]).toMatchObject({
      id: 1000,
      // the raw code is retained and the expanded label added beside it
      type: '020lead',
      type_label: 'lead-opinion',
      author_id: 42,
      per_curiam: false,
    });
  });

  // `opinions_cited` arrives as resource-URI strings; the handler mines the numeric
  // opinion ID out of each. Both consumption surfaces carry the derived list, and a
  // URI the pattern cannot match is dropped rather than surfacing as NaN.
  describe('cites extraction from opinions_cited URIs', () => {
    it('derives numeric opinion IDs into structuredContent and format() alike', async () => {
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue({
        ...baseCluster,
        sub_opinions: [
          {
            ...baseCluster.sub_opinions[0]!,
            opinions_cited: [
              '/api/rest/v4/opinions/999/',
              'https://www.courtlistener.com/api/rest/v4/opinions/1234/',
            ],
          },
        ],
      });
      const ctx = createMockContext({ errors: getOpinionTool.errors });
      const input = getOpinionTool.input.parse({ cluster_id: 100 });
      const result = await getOpinionTool.handler(input, ctx);

      expect(result.opinions?.[0]?.cites).toEqual([999, 1234]);

      const text = (getOpinionTool.format!(result)[0] as { text: string }).text;
      expect(text).toContain('**Cites:** 999, 1234');
    });

    it('drops a URI with no extractable opinion ID instead of emitting NaN', async () => {
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue({
        ...baseCluster,
        sub_opinions: [
          {
            ...baseCluster.sub_opinions[0]!,
            opinions_cited: ['/api/rest/v4/dockets/5000/', '/api/rest/v4/opinions/7/'],
          },
        ],
      });
      const ctx = createMockContext({ errors: getOpinionTool.errors });
      const input = getOpinionTool.input.parse({ cluster_id: 100 });
      const result = await getOpinionTool.handler(input, ctx);

      expect(result.opinions?.[0]?.cites).toEqual([7]);
    });

    it('renders no Cites line when the opinion cites nothing', async () => {
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue({
        ...baseCluster,
        sub_opinions: [{ ...baseCluster.sub_opinions[0]!, opinions_cited: [] }],
      });
      const ctx = createMockContext({ errors: getOpinionTool.errors });
      const input = getOpinionTool.input.parse({ cluster_id: 100 });
      const result = await getOpinionTool.handler(input, ctx);

      expect(result.opinions?.[0]?.cites).toEqual([]);
      const text = (getOpinionTool.format!(result)[0] as { text: string }).text;
      expect(text).not.toContain('**Cites:**');
    });
  });

  // #48 — /opinions/ serves the stored code ("030concurrence"); the numeric prefix is a
  // sort key, not part of the type. The label is CourtListener's own (o_type_index_map),
  // so get_opinion and search_opinions must agree on the value for the same variant.
  describe('opinion type expansion (#48)', () => {
    const mkVariant = (id: number, type: string) => ({
      id,
      type,
      author_id: null,
      per_curiam: false,
      html: '<p>text</p>',
      plain_text: '',
      download_url: null,
    });

    it('expands every opinion type code and passes unknown codes through', async () => {
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue({
        ...baseCluster,
        sub_opinions: [
          mkVariant(9425158, '030concurrence'),
          mkVariant(9425159, '040dissent'),
          mkVariant(9425160, '035concurrenceinpart'),
          mkVariant(9425161, '110somethingnew'),
        ],
      });
      const ctx = createMockContext({ errors: getOpinionTool.errors });
      const input = getOpinionTool.input.parse({ cluster_id: 100 });
      const result = await getOpinionTool.handler(input, ctx);

      expect(result.opinions?.map((o) => o.type_label)).toEqual([
        'concurrence-opinion',
        'dissent',
        'in-part-opinion',
        // a code CourtListener adds later stays visible rather than rendering empty
        '110somethingnew',
      ]);
      // the raw codes survive — expansion is additive, not a replacement
      expect(result.opinions?.map((o) => o.type)).toEqual([
        '030concurrence',
        '040dissent',
        '035concurrenceinpart',
        '110somethingnew',
      ]);
    });

    it('renders the expanded label in the section heading, with the code beside the ID', async () => {
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue({
        ...baseCluster,
        sub_opinions: [mkVariant(9425158, '030concurrence')],
      });
      const ctx = createMockContext({ errors: getOpinionTool.errors });
      const input = getOpinionTool.input.parse({ cluster_id: 100 });
      const result = await getOpinionTool.handler(input, ctx);
      const text = (getOpinionTool.format!(result)[0] as { text: string }).text;

      expect(text).toContain('### Opinion (concurrence\\-opinion)');
      expect(text).not.toContain('### Opinion (030concurrence)');
      expect(text).toContain('**Type code:** 030concurrence');
    });

    it('leaves type_label empty when upstream records no type', async () => {
      mockSvc.getOpinionCluster = vi
        .fn()
        .mockResolvedValue({ ...baseCluster, sub_opinions: [mkVariant(1, '')] });
      const ctx = createMockContext({ errors: getOpinionTool.errors });
      const input = getOpinionTool.input.parse({ cluster_id: 100 });
      const result = await getOpinionTool.handler(input, ctx);
      expect(result.opinions?.[0]?.type_label).toBe('');
    });
  });

  it('falls back across HTML variants for html_text when html/plain_text are empty', async () => {
    // Mirrors the real Roe v. Wade shape (cluster 108713): the lead/dissent
    // sub-opinions carry text only in html_with_citations / xml_harvard.
    const variantCluster: OpinionCluster = {
      ...baseCluster,
      sub_opinions: [
        {
          id: 9425157,
          type: '020lead',
          author_id: null,
          per_curiam: false,
          html: '',
          plain_text: '',
          html_with_citations: '<p>lead opinion via citations</p>',
          download_url: null,
        },
        {
          id: 9425159,
          type: '040dissent',
          author_id: null,
          per_curiam: false,
          html: '',
          plain_text: '',
          xml_harvard: '<opinion>dissent via harvard</opinion>',
          download_url: null,
        },
        {
          id: 9425160,
          type: '010combined',
          author_id: null,
          per_curiam: false,
          html: '<p>plain html</p>',
          plain_text: '',
          html_with_citations: '<p>combined via citations</p>',
          download_url: null,
        },
      ],
    };
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(variantCluster);
    const ctx = createMockContext({ errors: getOpinionTool.errors });
    const input = getOpinionTool.input.parse({ cluster_id: 100 });
    const result = await getOpinionTool.handler(input, ctx);

    // lead: only html_with_citations present → used
    expect(result.opinions?.[0]?.html_text).toBe('<p>lead opinion via citations</p>');
    // dissent: only xml_harvard present → deeper-variant fallback used
    expect(result.opinions?.[1]?.html_text).toBe('<opinion>dissent via harvard</opinion>');
    // combined: both html and html_with_citations present → citation-linked variant preferred
    expect(result.opinions?.[2]?.html_text).toBe('<p>combined via citations</p>');
    expect(result.opinions?.[0]?.plain_text).toBe('lead opinion via citations');
  });

  it('extracts docket_id from docket URI when not directly provided', async () => {
    const { docket_id: _omittedDocketId, ...clusterNoDocketId } = baseCluster;
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(clusterNoDocketId);
    const ctx = createMockContext({ errors: getOpinionTool.errors });
    const input = getOpinionTool.input.parse({ cluster_id: 100 });
    const result = await getOpinionTool.handler(input, ctx);
    expect(result.docket_id).toBe(5000);
  });

  it('still returns the opinion when docket backfill fails (non-fatal)', async () => {
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(baseCluster);
    mockSvc.getDocketSummary = vi.fn().mockRejectedValue(new Error('docket fetch failed'));
    const ctx = createMockContext({ errors: getOpinionTool.errors });
    const input = getOpinionTool.input.parse({ cluster_id: 100 });
    const result = await getOpinionTool.handler(input, ctx);
    expect(result.case_name).toBe('Roe v. Wade');
    // backfill failed → court_id/docket_number stay empty, but the opinion still returns
    expect(result.court_id).toBe('');
    expect(result.docket_number).toBe('');
  });

  it('throws not_found for missing cluster', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockSvc.getOpinionCluster = vi
      .fn()
      .mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'not found'));
    const ctx = createMockContext({ errors: getOpinionTool.errors });
    const input = getOpinionTool.input.parse({ cluster_id: 99999 });
    await expect(getOpinionTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  // #31 — the repro cluster (108713) has 4 independently-large sub-opinions inside one
  // `opinions` array. Overflow must split it into one section per variant while keeping
  // the cheap cluster metadata in every response.
  describe('outline-on-overflow (#31)', () => {
    const bigOpinionHtml = `<p>${'opinion body text. '.repeat(900)}</p>`; // ~17 KB each

    const overflowCluster: OpinionCluster = {
      ...baseCluster,
      sub_opinions: [
        {
          id: 111,
          type: '020lead',
          author_id: 42,
          per_curiam: false,
          html: bigOpinionHtml,
          plain_text: '',
          download_url: null,
        },
        {
          id: 222,
          type: '040dissent',
          author_id: 99,
          per_curiam: false,
          html: bigOpinionHtml,
          plain_text: '',
          download_url: null,
        },
      ],
    };

    it('overflows to a per-variant outline while keeping cheap cluster metadata', async () => {
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(overflowCluster);
      const ctx = createMockContext({ errors: getOpinionTool.errors });
      const input = getOpinionTool.input.parse({ cluster_id: 100 });
      const result = await getOpinionTool.handler(input, ctx);

      expect(result.kind).toBe('outline');
      // opinions omitted in outline mode
      expect(result.opinions).toBeUndefined();
      // one section per opinion variant, named opinion_<id>
      const names = (result.sections ?? []).map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining(['opinion_111', 'opinion_222']));
      expect(result.retrieval_notice).toContain('retrieval.next_cursor');
      // cheap cluster metadata survives overflow — present in every response
      expect(result.cluster_id).toBe(100);
      expect(result.case_name).toBe('Roe v. Wade');
      expect(result.court).toBe('Supreme Court of the United States');
      expect(result.citations).toEqual(['410 U.S. 113']);
      expect(result.syllabus).toBe('The right of privacy extends to reproductive choices.');
      // structuredContent parse holds
      expect(() => getOpinionTool.output.parse(result)).not.toThrow();
    });

    it('bounds a selected opinion variant on a section re-call', async () => {
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(overflowCluster);
      const ctx = createMockContext({ errors: getOpinionTool.errors });
      const input = getOpinionTool.input.parse({ cluster_id: 100, sections: ['opinion_222'] });
      const result = await getOpinionTool.handler(input, ctx);

      expect(result.kind).toBe('outline');
      expect(result.opinions).toBeUndefined();
      expect(result.sections?.map((section) => section.name)).toContain('opinion_222');
      expect(result.retrieval?.next_cursor).toEqual(expect.any(String));
      // cheap metadata still present alongside the selected variant
      expect(result.case_name).toBe('Roe v. Wade');
      expect(() => getOpinionTool.output.parse(result)).not.toThrow();
    });

    // #37 — an unmatched section name previously filtered to an empty list and
    // returned kind:'full' with no opinions and no notice that nothing matched.
    it('rejects a sections name matching no opinion variant', async () => {
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(overflowCluster);
      const ctx = createMockContext({ errors: getOpinionTool.errors });
      const input = getOpinionTool.input.parse({ cluster_id: 100, sections: ['not_a_section'] });

      const err = await captureError(() => getOpinionTool.handler(input, ctx));
      expect(err).toMatchObject({ data: { reason: 'unknown_section' } });
      expect(err.message).toContain('not_a_section');
      // the valid names for this cluster are listed back to the caller
      expect(err.message).toContain('opinion_111');
      expect(err.message).toContain('opinion_222');
    });

    it('rejects a partially-unknown sections list rather than silently dropping it', async () => {
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(overflowCluster);
      const ctx = createMockContext({ errors: getOpinionTool.errors });
      const input = getOpinionTool.input.parse({
        cluster_id: 100,
        sections: ['opinion_111', 'opinion_999'],
      });

      const err = await captureError(() => getOpinionTool.handler(input, ctx));
      expect(err).toMatchObject({ data: { reason: 'unknown_section' } });
      expect(err.message).toContain('opinion_999');
    });

    it('reports honestly when the cluster has no opinion variants at all', async () => {
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue({ ...baseCluster, sub_opinions: [] });
      const ctx = createMockContext({ errors: getOpinionTool.errors });
      const input = getOpinionTool.input.parse({ cluster_id: 100, sections: ['opinion_1'] });

      const err = await captureError(() => getOpinionTool.handler(input, ctx));
      expect(err).toMatchObject({ data: { reason: 'unknown_section' } });
      expect(err.message).toContain('no opinion variants');
    });
  });

  it('formats output including html_text and case_name_full', () => {
    const output = getOpinionTool.output.parse({
      kind: 'full',
      cluster_id: 100,
      case_name: 'Roe v. Wade',
      case_name_full: 'Roe v. Wade (Full Title)',
      court: 'Supreme Court',
      court_id: 'scotus',
      date_filed: '1973-01-22',
      docket_id: 5000,
      docket_number: '70-18',
      judges: 'Blackmun',
      citations: ['410 U.S. 113'],
      cite_count: 10000,
      precedential_status: 'Published',
      syllabus: 'Privacy includes reproductive choices.',
      posture: 'Appeal',
      opinions: [
        {
          id: 1000,
          type: '020lead',
          type_label: 'lead-opinion',
          author_id: 42,
          per_curiam: false,
          html_text: '<p>HTML opinion text here</p>',
          plain_text: '',
          cites: [999],
          download_url: 'https://example.com/doc.pdf',
        },
      ],
    });
    const blocks = getOpinionTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('100');
    expect(text).toContain('Roe v\\. Wade');
    expect(text).toContain('scotus');
    // case_name_full must be rendered
    expect(text).toContain('Roe v\\. Wade \\(Full Title\\)');
    // html_text must be rendered when plain_text is empty
    expect(text).toContain('HTML opinion text here');
    // #38 — the kind discriminator must reach content[], not just structuredContent
    expect(text).toContain('**Response mode:** full');
  });

  it('format renders plain_text when available', () => {
    const output = getOpinionTool.output.parse({
      kind: 'full',
      cluster_id: 101,
      case_name: 'Test v. Test',
      case_name_full: 'Test v. Test Full',
      court: 'Circuit Court',
      court_id: 'ca9',
      date_filed: '2020-01-01',
      docket_id: 6000,
      docket_number: '20-1',
      judges: 'Judge',
      citations: [],
      cite_count: 0,
      precedential_status: 'Unpublished',
      syllabus: '',
      posture: '',
      opinions: [
        {
          id: 2000,
          type: '020lead',
          type_label: 'lead-opinion',
          author_id: null,
          per_curiam: true,
          html_text: '<p>HTML text</p>',
          plain_text: 'Plain text version',
          cites: [],
          download_url: null,
        },
      ],
    });
    const blocks = getOpinionTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // plain_text shown when available
    expect(text).toContain('Plain text version');
  });

  it('format shows download_url when no text stored', () => {
    const output = getOpinionTool.output.parse({
      kind: 'full',
      cluster_id: 102,
      case_name: 'Sparse v. Case',
      case_name_full: '',
      court: 'District Court',
      court_id: 'dcd',
      date_filed: '2019-01-01',
      docket_id: 7000,
      docket_number: '19-1',
      judges: '',
      citations: [],
      cite_count: 0,
      precedential_status: 'Unknown',
      syllabus: '',
      posture: '',
      opinions: [
        {
          id: 3000,
          type: '010combined',
          type_label: 'combined-opinion',
          author_id: null,
          per_curiam: false,
          html_text: '',
          plain_text: '',
          cites: [],
          download_url: 'https://example.com/doc.pdf',
        },
      ],
    });
    const blocks = getOpinionTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('download_url');
  });

  it('format renders full opinion text without truncation (#31)', () => {
    const longText = 'opinion paragraph. '.repeat(3000); // ~57 KB
    const output = getOpinionTool.output.parse({
      kind: 'full',
      cluster_id: 100,
      case_name: 'Roe v. Wade',
      case_name_full: '',
      court: 'Supreme Court',
      court_id: 'scotus',
      date_filed: '1973-01-22',
      docket_id: 5000,
      docket_number: '70-18',
      judges: '',
      citations: [],
      cite_count: 0,
      precedential_status: 'Published',
      syllabus: '',
      posture: '',
      opinions: [
        {
          id: 1000,
          type: '020lead',
          type_label: 'lead-opinion',
          author_id: 42,
          per_curiam: false,
          html_text: longText,
          plain_text: '',
          cites: [],
          download_url: null,
        },
      ],
    });
    const blocks = getOpinionTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain(longText);
    expect(text).not.toContain('truncated');
  });

  it('format renders the opinion outline arm with cheap metadata (#31)', () => {
    const output = getOpinionTool.output.parse({
      kind: 'outline',
      cluster_id: 108713,
      case_name: 'Roe v. Wade',
      case_name_full: 'Jane Roe v. Henry Wade',
      court: 'Supreme Court of the United States',
      court_id: 'scotus',
      date_filed: '1973-01-22',
      docket_id: 5000,
      docket_number: '70-18',
      judges: 'Blackmun',
      citations: ['410 U.S. 113'],
      cite_count: 25000,
      precedential_status: 'Published',
      syllabus: 'Privacy includes reproductive choices.',
      posture: '',
      sections: [
        { name: 'opinion_9425157', bytes: 166178 },
        { name: 'opinion_9425159', bytes: 141669 },
      ],
      retrieval_notice:
        'Re-call with sections:["opinion_9425157"] to retrieve that variant in full.',
    });
    const blocks = getOpinionTool.format!(output);
    const text = blocks.map((b) => (b as { text: string }).text).join('\n');
    // cheap metadata rendered even in outline mode (survives overflow on content[] too)
    expect(text).toContain('Roe v\\. Wade');
    expect(text).toContain('410 U\\.S\\. 113');
    // outline section list + notice rendered
    expect(text).toContain('opinion\\_9425157');
    expect(text).toContain('sections available');
    expect(text).toContain('Re\\-call with sections');
    // #38 — the outline arm must label its mode too
    expect(text).toContain('**Response mode:** outline');
  });
});
