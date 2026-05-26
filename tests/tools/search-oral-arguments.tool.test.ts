/**
 * @fileoverview Tests for the search-oral-arguments tool.
 * @module tests/tools/search-oral-arguments.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
      download_url: 'https://storage.courtlistener.com/audio/case.mp3',
      local_path: '/local/audio/case.mp3',
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

    expect(result.total_count).toBe(1);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      audio_id: 400,
      case_name: 'Oral Argument Case',
      court_id: 'scotus',
      duration_seconds: 3600,
      panel_ids: [100, 101, 102],
    });
    expect(result.next_cursor).toBe('cursor123');
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

  it('formats output with duration_seconds and local_path', () => {
    const output = searchOralArgumentsTool.output.parse({
      total_count: 1,
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
          local_path: '/local/audio.mp3',
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
    // local_path must be rendered
    expect(text).toContain('/local/audio.mp3');
  });

  it('format handles empty results', () => {
    const output = searchOralArgumentsTool.output.parse({
      total_count: 0,
      results: [],
      next_cursor: null,
    });
    const blocks = searchOralArgumentsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No oral argument recordings');
  });
});
