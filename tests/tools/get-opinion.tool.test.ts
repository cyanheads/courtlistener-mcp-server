/**
 * @fileoverview Tests for the get-opinion tool.
 * @module tests/tools/get-opinion.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOpinionTool } from '@/mcp-server/tools/definitions/get-opinion.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';
import type { OpinionCluster } from '@/services/courtlistener/types.js';

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
      opinions_cited: [{ id: 999, resource_uri: '/api/rest/v4/opinions/999/' }],
      download_url: 'https://example.com/opinion.pdf',
    },
  ],
};

describe('getOpinionTool', () => {
  it('returns full cluster metadata for valid cluster_id', async () => {
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(baseCluster);
    const ctx = createMockContext();
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
      const ctx = createMockContext();
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
      const ctx = createMockContext();
      const input = getOpinionTool.input.parse({ cluster_id: 100 });
      const result = await getOpinionTool.handler(input, ctx);
      const text = (getOpinionTool.format!(result)[0] as { text: string }).text;

      expect(text).toContain('### Opinion (concurrence-opinion)');
      expect(text).not.toContain('### Opinion (030concurrence)');
      expect(text).toContain('**Type code:** 030concurrence');
    });

    it('leaves type_label empty when upstream records no type', async () => {
      mockSvc.getOpinionCluster = vi
        .fn()
        .mockResolvedValue({ ...baseCluster, sub_opinions: [mkVariant(1, '')] });
      const ctx = createMockContext();
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
    const ctx = createMockContext();
    const input = getOpinionTool.input.parse({ cluster_id: 100 });
    const result = await getOpinionTool.handler(input, ctx);

    // lead: only html_with_citations present → used
    expect(result.opinions?.[0]?.html_text).toBe('<p>lead opinion via citations</p>');
    // dissent: only xml_harvard present → deeper-variant fallback used
    expect(result.opinions?.[1]?.html_text).toBe('<opinion>dissent via harvard</opinion>');
    // combined: both html and html_with_citations present → citation-linked variant preferred
    expect(result.opinions?.[2]?.html_text).toBe('<p>combined via citations</p>');
    // plain_text stays its own (empty) field, not backfilled from the HTML variants
    expect(result.opinions?.[0]?.plain_text).toBe('');
  });

  it('extracts docket_id from docket URI when not directly provided', async () => {
    const clusterNoDocketId: OpinionCluster = { ...baseCluster, docket_id: undefined };
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(clusterNoDocketId);
    const ctx = createMockContext();
    const input = getOpinionTool.input.parse({ cluster_id: 100 });
    const result = await getOpinionTool.handler(input, ctx);
    expect(result.docket_id).toBe(5000);
  });

  it('still returns the opinion when docket backfill fails (non-fatal)', async () => {
    mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(baseCluster);
    mockSvc.getDocketSummary = vi.fn().mockRejectedValue(new Error('docket fetch failed'));
    const ctx = createMockContext();
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
      const ctx = createMockContext();
      const input = getOpinionTool.input.parse({ cluster_id: 100 });
      const result = await getOpinionTool.handler(input, ctx);

      expect(result.kind).toBe('outline');
      // opinions omitted in outline mode
      expect(result.opinions).toBeUndefined();
      // one section per opinion variant, named opinion_<id>
      const names = (result.sections ?? []).map((s) => s.name);
      expect(names).toEqual(expect.arrayContaining(['opinion_111', 'opinion_222']));
      expect(result.retrieval_notice).toContain('opinion_');
      // cheap cluster metadata survives overflow — present in every response
      expect(result.cluster_id).toBe(100);
      expect(result.case_name).toBe('Roe v. Wade');
      expect(result.court).toBe('Supreme Court of the United States');
      expect(result.citations).toEqual(['410 U.S. 113']);
      expect(result.syllabus).toBe('The right of privacy extends to reproductive choices.');
      // structuredContent parse holds
      expect(() => getOpinionTool.output.parse(result)).not.toThrow();
    });

    it('returns a selected opinion variant in full on a section re-call', async () => {
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue(overflowCluster);
      const ctx = createMockContext();
      const input = getOpinionTool.input.parse({ cluster_id: 100, sections: ['opinion_222'] });
      const result = await getOpinionTool.handler(input, ctx);

      expect(result.kind).toBe('full');
      expect(result.opinions).toHaveLength(1);
      expect(result.opinions?.[0]?.id).toBe(222);
      expect(result.opinions?.[0]?.html_text).toContain('opinion body text');
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

      const err = await getOpinionTool.handler(input, ctx).catch((e) => e);
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

      const err = await getOpinionTool.handler(input, ctx).catch((e) => e);
      expect(err).toMatchObject({ data: { reason: 'unknown_section' } });
      expect(err.message).toContain('opinion_999');
    });

    it('reports honestly when the cluster has no opinion variants at all', async () => {
      mockSvc.getOpinionCluster = vi.fn().mockResolvedValue({ ...baseCluster, sub_opinions: [] });
      const ctx = createMockContext({ errors: getOpinionTool.errors });
      const input = getOpinionTool.input.parse({ cluster_id: 100, sections: ['opinion_1'] });

      const err = await getOpinionTool.handler(input, ctx).catch((e) => e);
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
    expect(text).toContain('Roe v. Wade');
    expect(text).toContain('scotus');
    // case_name_full must be rendered
    expect(text).toContain('Roe v. Wade (Full Title)');
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
    expect(text).toContain('Roe v. Wade');
    expect(text).toContain('410 U.S. 113');
    // outline section list + notice rendered
    expect(text).toContain('opinion_9425157');
    expect(text).toContain('sections available');
    expect(text).toContain('Re-call with sections');
    // #38 — the outline arm must label its mode too
    expect(text).toContain('**Response mode:** outline');
  });
});
