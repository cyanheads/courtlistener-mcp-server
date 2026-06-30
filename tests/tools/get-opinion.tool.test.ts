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
  citations: [{ volume: 410, reporter: 'U.S.', page: '113', type: 1 }],
  citation_count: 10000,
  precedential_status: 'Published',
  syllabus: 'The right of privacy extends to reproductive choices.',
  posture: 'Appeal from district court',
  sub_opinions: [
    {
      id: 1000,
      type: 'lead-opinion',
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
    expect(result.opinions[0]).toMatchObject({
      id: 1000,
      type: 'lead-opinion',
      author_id: 42,
      per_curiam: false,
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
    expect(result.opinions[0].html_text).toBe('<p>lead opinion via citations</p>');
    // dissent: only xml_harvard present → deeper-variant fallback used
    expect(result.opinions[1].html_text).toBe('<opinion>dissent via harvard</opinion>');
    // combined: both html and html_with_citations present → citation-linked variant preferred
    expect(result.opinions[2].html_text).toBe('<p>combined via citations</p>');
    // plain_text stays its own (empty) field, not backfilled from the HTML variants
    expect(result.opinions[0].plain_text).toBe('');
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

  it('formats output including html_text and case_name_full', () => {
    const output = getOpinionTool.output.parse({
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
          type: 'lead-opinion',
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
  });

  it('format renders plain_text when available', () => {
    const output = getOpinionTool.output.parse({
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
          type: 'lead-opinion',
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
          type: 'combined-opinion',
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
});
