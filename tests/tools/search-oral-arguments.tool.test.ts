/**
 * @fileoverview Tests for the search-oral-arguments tool.
 * @module tests/tools/search-oral-arguments.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchOralArgumentsTool } from '@/mcp-server/tools/definitions/search-oral-arguments.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';

const mockSvc = {
  searchOralArguments: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

/**
 * `local_path` mirrors the real v4 shape — a bare relative path rooted at the
 * storage bucket, not an absolute URL. The previous fixture's `/local/audio/case.mp3`
 * never exercised the prefixing the tool now applies.
 */
const baseAudioResult = {
  total: 1,
  results: [
    {
      id: 400,
      caseName: 'Oral Argument Case',
      court: 'Supreme Court',
      court_id: 'scotus',
      dateArgued: '2023-10-03',
      docket_id: 9000,
      docketNumber: '22-1234',
      judge: 'Roberts, Thomas, Alito',
      panel_ids: [100, 101, 102],
      duration: 3600,
      download_url: 'http://www.supremecourt.gov/media/audio/mp3files/22-1234.mp3',
      local_path: 'mp3/2023/10/03/oral_argument_case_cl.mp3',
      snippet: 'argument transcript excerpt',
    },
  ],
  nextCursor: 'cursor123',
};

describe('searchOralArgumentsTool', () => {
  it('returns mapped oral argument records', async () => {
    mockSvc.searchOralArguments = vi.fn().mockResolvedValue(baseAudioResult);
    const ctx = createMockContext();
    const input = searchOralArgumentsTool.input.parse({ q: 'constitutional rights' });
    const result = await searchOralArgumentsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      audio_id: 400,
      case_name: 'Oral Argument Case',
      court_id: 'scotus',
      duration_seconds: 3600,
      panel_ids: [100, 101, 102],
    });
    expect(result.next_cursor).toBe('cursor123');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(1);
  });

  // #53 — local_path was passed through as a bare relative path, which nothing
  // downstream can fetch.
  describe('local_path storage URL (#53)', () => {
    it('resolves a bare relative path to a fetchable storage URL', async () => {
      mockSvc.searchOralArguments = vi.fn().mockResolvedValue(baseAudioResult);
      const ctx = createMockContext();
      const input = searchOralArgumentsTool.input.parse({ q: 'constitutional rights' });
      const result = await searchOralArgumentsTool.handler(input, ctx);

      expect(result.results[0].local_path).toBe(
        'https://storage.courtlistener.com/mp3/2023/10/03/oral_argument_case_cl.mp3',
      );
      // download_url is the court's own copy and is never rewritten.
      expect(result.results[0].download_url).toBe(
        'http://www.supremecourt.gov/media/audio/mp3files/22-1234.mp3',
      );
    });

    it('passes an already-absolute local_path through unchanged', async () => {
      mockSvc.searchOralArguments = vi.fn().mockResolvedValue({
        ...baseAudioResult,
        results: [
          {
            ...baseAudioResult.results[0],
            local_path: 'https://storage.courtlistener.com/mp3/2023/10/03/already_absolute.mp3',
          },
        ],
      });
      const ctx = createMockContext();
      const input = searchOralArgumentsTool.input.parse({ q: 'test' });
      const result = await searchOralArgumentsTool.handler(input, ctx);

      expect(result.results[0].local_path).toBe(
        'https://storage.courtlistener.com/mp3/2023/10/03/already_absolute.mp3',
      );
    });

    it('yields null when no copy is stored', async () => {
      mockSvc.searchOralArguments = vi.fn().mockResolvedValue({
        ...baseAudioResult,
        results: [{ ...baseAudioResult.results[0], local_path: null }],
      });
      const ctx = createMockContext();
      const input = searchOralArgumentsTool.input.parse({ q: 'test' });
      const result = await searchOralArgumentsTool.handler(input, ctx);

      expect(result.results[0].local_path).toBeNull();
    });
  });

  it('passes optional filters to service', async () => {
    mockSvc.searchOralArguments = vi
      .fn()
      .mockResolvedValue({ total: 0, results: [], nextCursor: null });
    const ctx = createMockContext();
    const input = searchOralArgumentsTool.input.parse({
      q: 'test',
      court: 'scotus',
      argued_after: '2022-01-01',
    });
    await searchOralArgumentsTool.handler(input, ctx);
    expect(mockSvc.searchOralArguments).toHaveBeenCalledWith(
      expect.objectContaining({ court: 'scotus', argued_after: '2022-01-01' }),
      ctx,
    );
  });

  it('throws when service throws', async () => {
    mockSvc.searchOralArguments = vi.fn().mockRejectedValue(new Error('rate limit'));
    const ctx = createMockContext();
    const input = searchOralArgumentsTool.input.parse({ q: 'test' });
    await expect(searchOralArgumentsTool.handler(input, ctx)).rejects.toThrow();
  });

  // #39 — a whitespace-only q previously reached CourtListener and spent one of
  // the 125 daily requests on unrelated recordings.
  describe('empty query (#39)', () => {
    it('trims q to empty and rejects without calling the service', async () => {
      mockSvc.searchOralArguments = vi.fn();
      const ctx = createMockContext({ errors: searchOralArgumentsTool.errors });
      const input = searchOralArgumentsTool.input.parse({ q: '   ' });
      expect(input.q).toBe('');

      const err = await searchOralArgumentsTool.handler(input, ctx).catch((e) => e);
      expect(err).toMatchObject({ data: { reason: 'empty_query' } });
      expect(err.message).toContain('q');
      expect(mockSvc.searchOralArguments).not.toHaveBeenCalled();
    });

    it('trims incidental padding from an otherwise-valid q', async () => {
      mockSvc.searchOralArguments = vi.fn().mockResolvedValue(baseAudioResult);
      const ctx = createMockContext();
      const input = searchOralArgumentsTool.input.parse({ q: '  qualified immunity  ' });
      await searchOralArgumentsTool.handler(input, ctx);
      expect(mockSvc.searchOralArguments).toHaveBeenCalledWith(
        expect.objectContaining({ q: 'qualified immunity' }),
        ctx,
      );
    });
  });

  // #40 — argued_after/argued_before share the /search/ date exposure.
  describe('invalid date filters (#40)', () => {
    for (const bad of ['banana', '2020-13-45', '2020-02-31']) {
      it(`rejects argued_after="${bad}" without calling the service`, async () => {
        mockSvc.searchOralArguments = vi.fn();
        const ctx = createMockContext({ errors: searchOralArgumentsTool.errors });
        const input = searchOralArgumentsTool.input.parse({ q: 'test', argued_after: bad });

        const err = await searchOralArgumentsTool.handler(input, ctx).catch((e) => e);
        expect(err).toMatchObject({ data: { reason: 'invalid_date' } });
        expect(err.message).toContain('argued_after');
        expect(err.message).toContain('YYYY-MM-DD');
        expect(mockSvc.searchOralArguments).not.toHaveBeenCalled();
      });
    }

    it('rejects a malformed argued_before without calling the service', async () => {
      mockSvc.searchOralArguments = vi.fn();
      const ctx = createMockContext({ errors: searchOralArgumentsTool.errors });
      const input = searchOralArgumentsTool.input.parse({ q: 'test', argued_before: '2021-02-29' });

      const err = await searchOralArgumentsTool.handler(input, ctx).catch((e) => e);
      expect(err).toMatchObject({ data: { reason: 'invalid_date' } });
      expect(err.message).toContain('argued_before');
      expect(mockSvc.searchOralArguments).not.toHaveBeenCalled();
    });

    it('lets valid calendar dates through to the service', async () => {
      mockSvc.searchOralArguments = vi.fn().mockResolvedValue(baseAudioResult);
      const ctx = createMockContext({ errors: searchOralArgumentsTool.errors });
      const input = searchOralArgumentsTool.input.parse({ q: 'test', argued_after: '2020-02-29' });
      await searchOralArgumentsTool.handler(input, ctx);
      expect(mockSvc.searchOralArguments).toHaveBeenCalledWith(
        expect.objectContaining({ argued_after: '2020-02-29' }),
        ctx,
      );
    });
  });

  it('formats output with duration_seconds and local_path', () => {
    const output = searchOralArgumentsTool.output.parse({
      results: [
        {
          audio_id: 400,
          case_name: 'Test Case',
          court: 'Supreme Court',
          court_id: 'scotus',
          date_argued: '2023-10-03',
          docket_id: 9000,
          docket_number: '22-1234',
          judges: 'Roberts',
          panel_ids: [100],
          duration_seconds: 3600,
          download_url: 'https://example.com/audio.mp3',
          local_path: 'https://storage.courtlistener.com/mp3/2023/10/03/case_cl.mp3',
          snippet: 'transcript excerpt',
        },
      ],
      next_cursor: null,
    });
    const blocks = searchOralArgumentsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('400');
    expect(text).toContain('Test Case');
    expect(text).toContain('scotus');
    // duration_seconds must appear in rendered text
    expect(text).toContain('3600');
    // local_path must be rendered — as the resolved storage URL (#53)
    expect(text).toContain('https://storage.courtlistener.com/mp3/2023/10/03/case_cl.mp3');
  });

  it('format handles empty results', () => {
    const output = searchOralArgumentsTool.output.parse({
      results: [],
      next_cursor: null,
    });
    const blocks = searchOralArgumentsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No oral argument recordings');
  });
});
