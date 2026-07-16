/**
 * @fileoverview Tests for the get-oral-argument tool.
 * @module tests/tools/get-oral-argument.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOralArgumentTool } from '@/mcp-server/tools/definitions/get-oral-argument.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';
import type { Audio } from '@/services/courtlistener/types.js';

const mockSvc = {
  getOralArgument: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

const baseAudio: Audio = {
  id: 105162,
  case_name: 'Arrowhead Capital Finance v. Seven Arts',
  case_name_full: 'Arrowhead Capital Finance, Ltd. v. Seven Arts Entertainment, Inc.',
  docket: 'https://www.courtlistener.com/api/rest/v4/dockets/73418842/',
  duration: 1607,
  download_url: 'https://www.courtlistener.com/audio/mp3/2014/05/05/case.mp3',
  judges: '',
  // The detail endpoint (/audio/{id}/) returns `panel` as full person resource URIs,
  // not bare integers — the handler extracts the numeric person id from each.
  panel: [
    'https://www.courtlistener.com/api/rest/v4/people/42/',
    'https://www.courtlistener.com/api/rest/v4/people/43/',
  ],
  stt_transcript: 'Good morning, your honors. May it please the court.',
  stt_status: 3,
  source: 'C',
};

describe('getOralArgumentTool', () => {
  it('returns full detail with transcript, panel, and docket id from URI', async () => {
    mockSvc.getOralArgument = vi.fn().mockResolvedValue(baseAudio);
    const ctx = createMockContext();
    const input = getOralArgumentTool.input.parse({ id: 105162 });
    const result = await getOralArgumentTool.handler(input, ctx);

    expect(result.kind).toBe('full');
    expect(result.oral_argument_id).toBe(105162);
    // docket_id is extracted from the resource URI
    expect(result.docket_id).toBe(73418842);
    expect(result.duration_seconds).toBe(1607);
    // panel person URIs normalized to numeric ids
    expect(result.panel_ids).toEqual([42, 43]);
    expect(result.has_transcript).toBe(true);
    expect(result.transcript).toBe('Good morning, your honors. May it please the court.');
  });

  // Regression for #30: the detail endpoint hands back /people/{id}/ URIs, which the
  // old code passed through verbatim and failed output validation on (panel_ids: number[]).
  it('normalizes panel person URIs to numeric ids and validates (#30)', async () => {
    mockSvc.getOralArgument = vi.fn().mockResolvedValue({
      ...baseAudio,
      panel: [
        'https://www.courtlistener.com/api/rest/v4/people/77/',
        'https://www.courtlistener.com/api/rest/v4/people/1250/',
        'https://www.courtlistener.com/api/rest/v4/people/8521/',
      ],
    });
    const ctx = createMockContext();
    const input = getOralArgumentTool.input.parse({ id: 105162 });
    const result = await getOralArgumentTool.handler(input, ctx);

    expect(result.panel_ids).toEqual([77, 1250, 8521]);
    // A non-empty panel no longer throws — the normalized record parses cleanly.
    expect(() => getOralArgumentTool.output.parse(result)).not.toThrow();
  });

  it('drops unparseable panel entries rather than emitting NaN', async () => {
    mockSvc.getOralArgument = vi.fn().mockResolvedValue({
      ...baseAudio,
      panel: ['https://www.courtlistener.com/api/rest/v4/people/77/', 'not-a-uri', ''],
    });
    const ctx = createMockContext();
    const input = getOralArgumentTool.input.parse({ id: 105162 });
    const result = await getOralArgumentTool.handler(input, ctx);
    expect(result.panel_ids).toEqual([77]);
  });

  it('reports has_transcript false when transcript is empty', async () => {
    mockSvc.getOralArgument = vi.fn().mockResolvedValue({ ...baseAudio, stt_transcript: '' });
    const ctx = createMockContext();
    const input = getOralArgumentTool.input.parse({ id: 105162 });
    const result = await getOralArgumentTool.handler(input, ctx);
    expect(result.has_transcript).toBe(false);
    expect(result.transcript).toBe('');
  });

  it('throws not_found for a missing audio id', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockSvc.getOralArgument = vi
      .fn()
      .mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'not found'));
    const ctx = createMockContext({ errors: getOralArgumentTool.errors });
    const input = getOralArgumentTool.input.parse({ id: 99999 });
    await expect(getOralArgumentTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  // #31 — a long transcript overflows the inline byte budget and returns a section
  // outline instead of a truncated payload.
  describe('outline-on-overflow (#31)', () => {
    const longTranscript = 'The Court will hear argument. '.repeat(1100); // ~33 KB

    it('overflows to a section outline dominated by the transcript', async () => {
      mockSvc.getOralArgument = vi
        .fn()
        .mockResolvedValue({ ...baseAudio, stt_transcript: longTranscript });
      const ctx = createMockContext();
      const input = getOralArgumentTool.input.parse({ id: 105162 });
      const result = await getOralArgumentTool.handler(input, ctx);

      expect(result.kind).toBe('outline');
      // full-mode fields are dropped in outline mode
      expect(result.transcript).toBeUndefined();
      expect(result.oral_argument_id).toBeUndefined();
      const sections = result.sections ?? [];
      expect(sections.map((s) => s.name)).toContain('transcript');
      // transcript is the largest section
      expect(sections[0]?.name).toBe('transcript');
      expect(result.retrieval_notice).toContain('sections');
      // structuredContent parse holds
      expect(() => getOralArgumentTool.output.parse(result)).not.toThrow();
    });

    it('returns the full transcript on a section re-call', async () => {
      mockSvc.getOralArgument = vi
        .fn()
        .mockResolvedValue({ ...baseAudio, stt_transcript: longTranscript });
      const ctx = createMockContext();
      const input = getOralArgumentTool.input.parse({ id: 105162, sections: ['transcript'] });
      const result = await getOralArgumentTool.handler(input, ctx);

      expect(result.kind).toBe('full');
      expect(result.transcript).toBe(longTranscript);
      // identity fields retained via alwaysKeep
      expect(result.oral_argument_id).toBe(105162);
      expect(result.case_name).toBe(baseAudio.case_name);
      expect(() => getOralArgumentTool.output.parse(result)).not.toThrow();
    });
  });

  // #37 — selectSections silently drops names matching no key, so an unknown
  // section previously returned kind:'full' carrying only the alwaysKeep fields.
  describe('unknown section names (#37)', () => {
    it('rejects a sections name that is not a field of the record', async () => {
      mockSvc.getOralArgument = vi.fn().mockResolvedValue(baseAudio);
      const ctx = createMockContext({ errors: getOralArgumentTool.errors });
      const input = getOralArgumentTool.input.parse({ id: 105162, sections: ['not_a_section'] });

      const err = await getOralArgumentTool.handler(input, ctx).catch((e) => e);
      expect(err).toMatchObject({ data: { reason: 'unknown_section' } });
      expect(err.message).toContain('not_a_section');
      // the valid vocabulary is listed back to the caller
      expect(err.message).toContain('transcript');
    });

    it('rejects a partially-unknown sections list rather than silently dropping it', async () => {
      mockSvc.getOralArgument = vi.fn().mockResolvedValue(baseAudio);
      const ctx = createMockContext({ errors: getOralArgumentTool.errors });
      const input = getOralArgumentTool.input.parse({
        id: 105162,
        sections: ['transcript', 'nope'],
      });

      const err = await getOralArgumentTool.handler(input, ctx).catch((e) => e);
      expect(err).toMatchObject({ data: { reason: 'unknown_section' } });
      expect(err.message).toContain('nope');
    });

    it('still accepts every real record field as a section name', async () => {
      mockSvc.getOralArgument = vi.fn().mockResolvedValue(baseAudio);
      const ctx = createMockContext({ errors: getOralArgumentTool.errors });
      const input = getOralArgumentTool.input.parse({
        id: 105162,
        sections: ['transcript', 'panel_ids', 'download_url'],
      });
      const result = await getOralArgumentTool.handler(input, ctx);
      expect(result.kind).toBe('full');
      expect(result.panel_ids).toEqual([42, 43]);
    });
  });

  it('formats output with duration, panel, and transcript', () => {
    const output = getOralArgumentTool.output.parse({
      kind: 'full',
      oral_argument_id: 105162,
      case_name: 'Arrowhead Capital Finance v. Seven Arts',
      case_name_full: 'Arrowhead Capital Finance, Ltd. v. Seven Arts Entertainment, Inc.',
      docket_id: 73418842,
      duration_seconds: 1607,
      download_url: 'https://www.courtlistener.com/audio/mp3/case.mp3',
      judges: '',
      panel_ids: [42, 43],
      has_transcript: true,
      transcript: 'Good morning, your honors.',
    });
    const blocks = getOralArgumentTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('105162');
    expect(text).toContain('Arrowhead Capital Finance v. Seven Arts');
    // duration rendered (1607s = 26m 47s)
    expect(text).toContain('1607');
    // panel ids rendered
    expect(text).toContain('42');
    // transcript rendered
    expect(text).toContain('Good morning, your honors.');
    // #38 — the kind discriminator must reach content[], not just structuredContent
    expect(text).toContain('**Response mode:** full');
  });

  it('format renders the full transcript without truncation (full arm)', () => {
    const longTranscript = 'ARGUMENT SESSION. '.repeat(2000); // ~36 KB
    const output = getOralArgumentTool.output.parse({
      kind: 'full',
      oral_argument_id: 105162,
      case_name: 'X v. Y',
      case_name_full: 'X v. Y (Full)',
      docket_id: 5,
      duration_seconds: 100,
      download_url: null,
      judges: '',
      panel_ids: [42],
      has_transcript: true,
      transcript: longTranscript,
    });
    const blocks = getOralArgumentTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // full text present, no truncation marker
    expect(text).toContain(longTranscript);
    expect(text).not.toContain('truncated');
  });

  it('format renders the outline arm with sections and notice', () => {
    const output = getOralArgumentTool.output.parse({
      kind: 'outline',
      sections: [
        { name: 'transcript', bytes: 33000 },
        { name: 'case_name_full', bytes: 64 },
      ],
      retrieval_notice: 'Re-call with sections:["transcript"] to retrieve the full transcript.',
    });
    const blocks = getOralArgumentTool.format!(output);
    const text = blocks.map((b) => (b as { text: string }).text).join('\n');
    expect(text).toContain('transcript');
    expect(text).toContain('sections available');
    expect(text).toContain('Re-call with sections');
    // #38 — a pure outline drops every record field, so the mode line is the only
    // signal that the payload is an outline; it must still reach content[].
    expect(text).toContain('**Response mode:** outline');
  });
});
