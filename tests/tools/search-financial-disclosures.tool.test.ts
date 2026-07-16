/**
 * @fileoverview Tests for the search-financial-disclosures tool.
 * @module tests/tools/search-financial-disclosures.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchFinancialDisclosuresTool } from '@/mcp-server/tools/definitions/search-financial-disclosures.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';
import type { FinancialDisclosure } from '@/services/courtlistener/types.js';

const mockSvc = {
  searchFinancialDisclosures: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

const baseDisclosure: FinancialDisclosure = {
  id: 34210,
  person: 'https://www.courtlistener.com/api/rest/v4/people/1609/',
  year: 2022,
  report_type: 2,
  page_count: 11,
  has_been_extracted: true,
  is_amended: false,
  filepath: 'https://storage.courtlistener.com/disclosures/2022/1609.pdf',
  // The search tool reads only `.length` for these count-only categories, so the
  // element shape is irrelevant here — cast placeholder arrays to the row types.
  investments: Array.from(
    { length: 50 },
    () => ({}),
  ) as unknown as FinancialDisclosure['investments'],
  gifts: [{ description: 'Lodging at conference', source: 'Bar Association', value: '$1,000.00' }],
  debts: [],
  positions: Array.from({ length: 8 }, () => ({})) as unknown as FinancialDisclosure['positions'],
  reimbursements: [],
  agreements: [],
  non_investment_incomes: [],
  spouse_incomes: [],
};

describe('searchFinancialDisclosuresTool', () => {
  it('maps a disclosure to summary, counts, and itemized gifts', async () => {
    mockSvc.searchFinancialDisclosures = vi
      .fn()
      .mockResolvedValue({ total: 2, results: [baseDisclosure], nextCursor: null });
    const ctx = createMockContext();
    const input = searchFinancialDisclosuresTool.input.parse({ judge_id: 1609, year: 2022 });
    const result = await searchFinancialDisclosuresTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    const d = result.results[0];
    expect(d.disclosure_id).toBe(34210);
    // person id is extracted from the resource URI
    expect(d.person_id).toBe(1609);
    // report_type code 2 maps to Annual
    expect(d.report_type).toBe('Annual');
    expect(d.counts.investments).toBe(50);
    expect(d.counts.positions).toBe(8);
    expect(d.counts.gifts).toBe(1);
    expect(d.gifts[0]).toEqual({
      description: 'Lodging at conference',
      source: 'Bar Association',
      value: '$1,000.00',
    });
    expect(d.pdf_url).toContain('.pdf');

    // judge_id maps to the person query param
    expect(mockSvc.searchFinancialDisclosures).toHaveBeenCalledWith(
      expect.objectContaining({ person: 1609 }),
      ctx,
    );
  });

  it('filters by year client-side and does not send year to the API', async () => {
    const d2022 = baseDisclosure;
    const d2021 = { ...baseDisclosure, id: 34205, year: 2021 };
    mockSvc.searchFinancialDisclosures = vi
      .fn()
      .mockResolvedValue({ total: null, results: [d2022, d2021], nextCursor: null });
    const ctx = createMockContext();
    const input = searchFinancialDisclosuresTool.input.parse({ judge_id: 1609, year: 2021 });
    const result = await searchFinancialDisclosuresTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].year).toBe(2021);
    expect(result.results[0].disclosure_id).toBe(34205);
    // year is a client-side filter — the API (which 400s on unknown params) never sees it
    expect(mockSvc.searchFinancialDisclosures).toHaveBeenCalledWith(
      expect.not.objectContaining({ year: expect.anything() }),
      ctx,
    );
  });

  it('emits a recovery notice on empty results', async () => {
    mockSvc.searchFinancialDisclosures = vi
      .fn()
      .mockResolvedValue({ total: null, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchFinancialDisclosuresTool.input.parse({ judge_id: 99999 });
    const result = await searchFinancialDisclosuresTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('No financial disclosures');
  });

  it('formats output with report type, counts, gifts, and PDF link', () => {
    const output = searchFinancialDisclosuresTool.output.parse({
      results: [
        {
          disclosure_id: 34210,
          person_id: 1609,
          year: 2022,
          report_type: 'Annual',
          page_count: 11,
          has_been_extracted: true,
          is_amended: false,
          pdf_url: 'https://storage.courtlistener.com/disclosures/2022/1609.pdf',
          counts: {
            investments: 50,
            gifts: 1,
            debts: 0,
            positions: 8,
            reimbursements: 0,
            agreements: 0,
            non_investment_incomes: 0,
            spouse_incomes: 0,
          },
          gifts: [
            { description: 'Lodging at conference', source: 'Bar Association', value: '$1,000.00' },
          ],
        },
      ],
      next_cursor: null,
    });
    const blocks = searchFinancialDisclosuresTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Annual');
    expect(text).toContain('2022');
    expect(text).toContain('34210');
    expect(text).toContain('1609');
    // counts rendered
    expect(text).toContain('50 investments');
    // gift itemized
    expect(text).toContain('Lodging at conference');
    expect(text).toContain('$1,000.00');
    // source PDF link rendered
    expect(text).toContain('.pdf');
  });

  it('format handles empty results', () => {
    const output = searchFinancialDisclosuresTool.output.parse({ results: [], next_cursor: null });
    const blocks = searchFinancialDisclosuresTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No financial disclosure');
  });

  it('page_size defaults to 20 and documents the 20-result floor (#33)', () => {
    expect(searchFinancialDisclosuresTool.input.parse({}).page_size).toBe(20);
    const desc = searchFinancialDisclosuresTool.input.shape.page_size.description ?? '';
    expect(desc).toMatch(/minimum of 20/i);
  });

  it('flags an empty year-filtered page as page-local when more pages exist (#36)', async () => {
    // The page carries a filing, but for a different year — the local year filter zeroes it.
    const otherYear = { ...baseDisclosure, id: 34999, year: 2019 };
    mockSvc.searchFinancialDisclosures = vi
      .fn()
      .mockResolvedValue({ total: null, results: [otherYear], nextCursor: 'cD05MDY=' });
    const ctx = createMockContext();
    const input = searchFinancialDisclosuresTool.input.parse({ judge_id: 3045, year: 2010 });
    const result = await searchFinancialDisclosuresTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    // the continuation survives on the returned object
    expect(result.next_cursor).toBe('cD05MDY=');
    const enrichment = getEnrichment(ctx);
    // Pre-fix this was the generic "not all judges have disclosures" notice with no cursor.
    expect(enrichment.notice).toContain('more pages exist');
    expect(enrichment.notice).toContain('cursor=cD05MDY=');
  });

  it('keeps the generic recovery notice when the page is genuinely empty (#36)', async () => {
    mockSvc.searchFinancialDisclosures = vi
      .fn()
      .mockResolvedValue({ total: null, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchFinancialDisclosuresTool.input.parse({ judge_id: 99999, year: 2010 });
    await searchFinancialDisclosuresTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('No financial disclosures found');
    expect(enrichment.notice).not.toContain('more pages exist');
  });

  it('renders next_cursor on an empty filtered page instead of returning early (#36)', () => {
    const output = searchFinancialDisclosuresTool.output.parse({
      results: [],
      next_cursor: 'cD05MDY=',
    });
    const blocks = searchFinancialDisclosuresTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // Pre-fix, format() early-returned on empty results and dropped the cursor from content[].
    expect(text).toContain('Next page cursor');
    expect(text).toContain('cD05MDY=');
  });

  it('documents the year filter as page-local in describe and description (#36)', () => {
    const desc = searchFinancialDisclosuresTool.input.shape.year.description ?? '';
    expect(desc).toMatch(/fetched page only/i);
    expect(searchFinancialDisclosuresTool.description).toMatch(/fetched page only/i);
  });
});
