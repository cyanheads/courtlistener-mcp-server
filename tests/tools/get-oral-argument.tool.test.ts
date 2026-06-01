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
  panel: [42, 43],
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

    expect(result.oral_argument_id).toBe(105162);
    // docket_id is extracted from the resource URI
    expect(result.docket_id).toBe(73418842);
    expect(result.duration_seconds).toBe(1607);
    expect(result.panel_ids).toEqual([42, 43]);
    expect(result.has_transcript).toBe(true);
    expect(result.transcript).toBe('Good morning, your honors. May it please the court.');
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

  it('formats output with duration, panel, and transcript', () => {
    const output = getOralArgumentTool.output.parse({
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
  });
});
