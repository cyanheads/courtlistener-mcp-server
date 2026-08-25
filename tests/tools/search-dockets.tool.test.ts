/**
 * @fileoverview Tests for the search-dockets tool.
 * @module tests/tools/search-dockets.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchDocketsTool } from '@/mcp-server/tools/definitions/search-dockets.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';
import { captureError } from '../helpers/capture-error.js';

const mockSvc = {
  searchDockets: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

/**
 * Keys mirror a captured `/search/?type=r` v4 response — `party`/`attorney`/`firm`
 * (not `party_name`), `recap_documents[].entry_date_filed` (not `date_filed`), and
 * no `document_count` anywhere in the payload. Fixtures written against the old
 * type names were exactly why the suite stayed green while the fields were dead.
 */
const baseDocketResult = {
  total: 1,
  results: [
    {
      docket_id: 8000,
      caseName: 'Apple Inc. v. Samsung Electronics',
      case_name_full: 'Apple Inc. v. Samsung Electronics Co., Ltd.',
      court: 'Northern District of California',
      court_id: 'cand',
      dateFiled: '2011-04-15',
      dateTerminated: '2018-06-27',
      docketNumber: '11-cv-01846',
      pacer_case_id: 'pacer123',
      assignedTo: 'Judge Koh',
      referredTo: 'Judge Grewal',
      cause: 'Patent Infringement',
      juryDemand: 'Both',
      suitNature: 'Patent',
      jurisdictionType: 'Federal Question',
      party: ['Apple Inc.', 'Samsung Electronics'],
      attorney: ['Diane Cafferata Hutnyan', 'Lara Sue Garner'],
      firm: ['Quinn Emanuel Urquhart & Sullivan LLP'],
      recap_documents: [
        {
          id: 90000,
          description: 'Complaint',
          document_number: 1,
          document_type: 'PACER Document',
          entry_date_filed: '2011-04-15',
          entry_number: 1,
          filepath_local: 'recap/gov.uscourts.cand.239768/gov.uscourts.cand.239768.1.0.pdf',
          is_available: true,
          page_count: 38,
        },
      ],
    },
  ],
  nextCursor: null,
};

describe('searchDocketsTool', () => {
  it('returns mapped docket summaries and enriches total for valid input', async () => {
    mockSvc.searchDockets = vi.fn().mockResolvedValue(baseDocketResult);
    const ctx = createMockContext({ errors: searchDocketsTool.errors });
    const input = searchDocketsTool.input.parse({ q: 'Apple Samsung patent' });
    const result = await searchDocketsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      docket_id: 8000,
      case_name: 'Apple Inc. v. Samsung Electronics',
      court_id: 'cand',
      jury_demand: 'Both',
    });
    expect(result.results[0]!.parties).toEqual(['Apple Inc.', 'Samsung Electronics']);
    expect(result.results[0]!.sample_documents).toHaveLength(1);
    expect(result.coverage_note).toBeTruthy();

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  // #42 — parties, document_count, and per-document date_filed were mapped from key
  // names the v4 RECAP search response does not use, so each was dead on every call.
  describe('v4 response key mapping (#42)', () => {
    it('reads parties from `party`, not the `party_name` input filter', async () => {
      mockSvc.searchDockets = vi.fn().mockResolvedValue(baseDocketResult);
      const ctx = createMockContext({ errors: searchDocketsTool.errors });
      const input = searchDocketsTool.input.parse({ q: 'Apple Samsung patent' });
      const result = await searchDocketsTool.handler(input, ctx);

      expect(result.results[0]!.parties).toEqual(['Apple Inc.', 'Samsung Electronics']);
      expect(result.results[0]!.parties).not.toEqual([]);
    });

    it('reads a sample document date from `entry_date_filed`', async () => {
      mockSvc.searchDockets = vi.fn().mockResolvedValue(baseDocketResult);
      const ctx = createMockContext({ errors: searchDocketsTool.errors });
      const input = searchDocketsTool.input.parse({ q: 'Apple Samsung patent' });
      const result = await searchDocketsTool.handler(input, ctx);

      expect(result.results[0]!.sample_documents[0]!.date_filed).toBe('2011-04-15');
    });

    it('drops document_count — no v4 field backs it, and 0 read as a real total', async () => {
      mockSvc.searchDockets = vi.fn().mockResolvedValue(baseDocketResult);
      const ctx = createMockContext({ errors: searchDocketsTool.errors });
      const input = searchDocketsTool.input.parse({ q: 'Apple Samsung patent' });
      const result = await searchDocketsTool.handler(input, ctx);

      expect(result.results[0]).not.toHaveProperty('document_count');
      expect(searchDocketsTool.output.shape.results.element.shape).not.toHaveProperty(
        'document_count',
      );
    });

    it('surfaces attorneys, firms, and the remaining adjacent docket fields', async () => {
      mockSvc.searchDockets = vi.fn().mockResolvedValue(baseDocketResult);
      const ctx = createMockContext({ errors: searchDocketsTool.errors });
      const input = searchDocketsTool.input.parse({ q: 'Apple Samsung patent' });
      const result = await searchDocketsTool.handler(input, ctx);

      expect(result.results[0]).toMatchObject({
        attorneys: ['Diane Cafferata Hutnyan', 'Lara Sue Garner'],
        firms: ['Quinn Emanuel Urquhart & Sullivan LLP'],
        case_name_full: 'Apple Inc. v. Samsung Electronics Co., Ltd.',
        suit_nature: 'Patent',
        jurisdiction_type: 'Federal Question',
        referred_to: 'Judge Grewal',
      });
      expect(result.results[0]!.sample_documents[0]).toMatchObject({
        entry_number: 1,
        page_count: 38,
        document_type: 'PACER Document',
      });
    });

    it('resolves a sample document filepath_local to a storage URL', async () => {
      mockSvc.searchDockets = vi.fn().mockResolvedValue(baseDocketResult);
      const ctx = createMockContext({ errors: searchDocketsTool.errors });
      const input = searchDocketsTool.input.parse({ q: 'Apple Samsung patent' });
      const result = await searchDocketsTool.handler(input, ctx);

      expect(result.results[0]!.sample_documents[0]!.filepath_local).toBe(
        'https://storage.courtlistener.com/recap/gov.uscourts.cand.239768/gov.uscourts.cand.239768.1.0.pdf',
      );
    });

    it('tolerates a sparse docket with none of the optional fields', async () => {
      mockSvc.searchDockets = vi.fn().mockResolvedValue({
        total: 1,
        results: [
          {
            docket_id: 8001,
            caseName: 'Sparse Docket',
            court: 'District Court',
            court_id: 'dnd',
            dateFiled: '2020-01-01',
            dateTerminated: null,
            docketNumber: '20-cv-1',
            pacer_case_id: null,
            assignedTo: null,
            cause: '',
            juryDemand: '',
          },
        ],
        nextCursor: null,
      });
      const ctx = createMockContext({ errors: searchDocketsTool.errors });
      const input = searchDocketsTool.input.parse({ q: 'sparse' });
      const result = await searchDocketsTool.handler(input, ctx);

      expect(result.results[0]).toMatchObject({
        parties: [],
        attorneys: [],
        firms: [],
        case_name_full: '',
        suit_nature: '',
        jurisdiction_type: '',
        referred_to: null,
        sample_documents: [],
      });
      // Schema conformance is the real assertion — a missing optional must not throw.
      expect(() => searchDocketsTool.output.parse(result)).not.toThrow();
    });
  });

  it('passes optional filters to service', async () => {
    mockSvc.searchDockets = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext({ errors: searchDocketsTool.errors });
    const input = searchDocketsTool.input.parse({
      q: 'test',
      court: 'deb',
      party_name: 'Acme Corp',
    });
    await searchDocketsTool.handler(input, ctx);
    expect(mockSvc.searchDockets).toHaveBeenCalledWith(
      expect.objectContaining({ court: 'deb', party_name: 'Acme Corp' }),
      ctx,
    );
  });

  it('caps sample_documents at 3', async () => {
    const manyDocs = Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      description: `Doc ${i + 1}`,
      document_number: i + 1,
      document_type: 'PACER Document',
      entry_date_filed: '2020-01-01',
      entry_number: i + 1,
      filepath_local: null,
      is_available: true,
      page_count: null,
    }));
    mockSvc.searchDockets = vi.fn().mockResolvedValue({
      total: 1,
      results: [{ ...baseDocketResult.results[0], recap_documents: manyDocs }],
      nextCursor: null,
    });
    const ctx = createMockContext({ errors: searchDocketsTool.errors });
    const input = searchDocketsTool.input.parse({ q: 'test' });
    const result = await searchDocketsTool.handler(input, ctx);
    expect(result.results[0]!.sample_documents).toHaveLength(3);
  });

  it('enriches notice on empty results', async () => {
    mockSvc.searchDockets = vi.fn().mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext({ errors: searchDocketsTool.errors });
    const input = searchDocketsTool.input.parse({ q: 'obscure case xyz', court: 'deb' });
    const result = await searchDocketsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(0);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('obscure case xyz');
  });

  it('throws when service throws', async () => {
    mockSvc.searchDockets = vi.fn().mockRejectedValue(new Error('rate limit'));
    const ctx = createMockContext({ errors: searchDocketsTool.errors });
    const input = searchDocketsTool.input.parse({ q: 'test' });
    await expect(searchDocketsTool.handler(input, ctx)).rejects.toThrow();
  });

  // #39 — a whitespace-only q previously reached CourtListener and returned
  // unrelated dockets while spending one of the 125 daily requests.
  describe('empty query (#39)', () => {
    it('trims q to empty and rejects without calling the service', async () => {
      mockSvc.searchDockets = vi.fn();
      const ctx = createMockContext({ errors: searchDocketsTool.errors });
      const input = searchDocketsTool.input.parse({ q: '   ' });
      expect(input.q).toBe('');

      const err = await captureError(() => searchDocketsTool.handler(input, ctx));
      expect(err).toMatchObject({ data: { reason: 'empty_query' } });
      expect(err.message).toContain('q');
      expect(mockSvc.searchDockets).not.toHaveBeenCalled();
    });

    it('trims incidental padding from an otherwise-valid q', async () => {
      mockSvc.searchDockets = vi.fn().mockResolvedValue(baseDocketResult);
      const ctx = createMockContext({ errors: searchDocketsTool.errors });
      const input = searchDocketsTool.input.parse({ q: '  Apple Inc  ' });
      await searchDocketsTool.handler(input, ctx);
      expect(mockSvc.searchDockets).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'Apple Inc' }),
        ctx,
      );
    });
  });

  // #40 — malformed dates reached the /search/ endpoint and returned an opaque 400.
  describe('invalid date filters (#40)', () => {
    for (const bad of ['banana', '2020-13-45', '2020-02-31']) {
      it(`rejects filed_after="${bad}" without calling the service`, async () => {
        mockSvc.searchDockets = vi.fn();
        const ctx = createMockContext({ errors: searchDocketsTool.errors });
        const input = searchDocketsTool.input.parse({ q: 'patent', filed_after: bad });

        const err = await captureError(() => searchDocketsTool.handler(input, ctx));
        expect(err).toMatchObject({ data: { reason: 'invalid_date' } });
        expect(err.message).toContain('filed_after');
        expect(err.message).toContain('YYYY-MM-DD');
        expect(mockSvc.searchDockets).not.toHaveBeenCalled();
      });
    }

    it('rejects a malformed filed_before without calling the service', async () => {
      mockSvc.searchDockets = vi.fn();
      const ctx = createMockContext({ errors: searchDocketsTool.errors });
      const input = searchDocketsTool.input.parse({ q: 'patent', filed_before: '2021-02-29' });

      const err = await captureError(() => searchDocketsTool.handler(input, ctx));
      expect(err).toMatchObject({ data: { reason: 'invalid_date' } });
      expect(err.message).toContain('filed_before');
      expect(mockSvc.searchDockets).not.toHaveBeenCalled();
    });

    it('lets valid calendar dates through to the service', async () => {
      mockSvc.searchDockets = vi.fn().mockResolvedValue(baseDocketResult);
      const ctx = createMockContext({ errors: searchDocketsTool.errors });
      const input = searchDocketsTool.input.parse({ q: 'patent', filed_after: '2020-02-29' });
      await searchDocketsTool.handler(input, ctx);
      expect(mockSvc.searchDockets).toHaveBeenCalledWith(
        expect.objectContaining({ filed_after: '2020-02-29' }),
        ctx,
      );
    });
  });

  it('formats output with all required fields', () => {
    const output = searchDocketsTool.output.parse({
      results: [
        {
          docket_id: 8000,
          case_name: 'Apple v. Samsung',
          case_name_full: 'Apple Inc. v. Samsung Electronics Co., Ltd.',
          court: 'N.D. Cal.',
          court_id: 'cand',
          date_filed: '2011-04-15',
          date_terminated: '2018-06-27',
          docket_number: '11-cv-01846',
          pacer_case_id: 'pacer123',
          assigned_to: 'Judge Koh',
          referred_to: 'Judge Grewal',
          cause: 'Patent Infringement',
          jury_demand: 'Both',
          suit_nature: 'Patent',
          jurisdiction_type: 'Federal Question',
          parties: ['Apple Inc.', 'Samsung'],
          attorneys: ['Diane Cafferata Hutnyan'],
          firms: ['Quinn Emanuel Urquhart & Sullivan LLP'],
          sample_documents: [
            {
              id: 90000,
              description: 'Complaint',
              date_filed: '2011-04-15',
              document_number: 1,
              entry_number: 1,
              document_type: 'PACER Document',
              page_count: 38,
              filepath_local: 'https://storage.courtlistener.com/recap/doc.pdf',
              is_available: true,
            },
          ],
        },
      ],
      next_cursor: null,
      coverage_note: 'RECAP coverage is partial.',
    });
    const blocks = searchDocketsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('8000');
    expect(text).toContain('Apple v. Samsung');
    // jury_demand must be rendered
    expect(text).toContain('Both');
    // sample_documents[].id must be rendered
    expect(text).toContain('90000');
    // #42 — the fields that were dead or dropped must reach content[] too
    expect(text).toContain('Diane Cafferata Hutnyan');
    expect(text).toContain('Quinn Emanuel Urquhart & Sullivan LLP');
    expect(text).toContain('Patent');
    expect(text).toContain('Federal Question');
    expect(text).toContain('Judge Grewal');
    expect(text).toContain('https://storage.courtlistener.com/recap/doc.pdf');
    expect(text).toContain('38pp');
    // the fabricated "**Documents:** 0" line is gone
    expect(text).not.toContain('**Documents:**');
  });
});
