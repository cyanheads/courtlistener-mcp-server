/**
 * @fileoverview Fetch full detail for a single oral argument audio recording.
 * @module mcp-server/tools/definitions/get-oral-argument.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

export const getOralArgumentTool = tool('courtlistener_get_oral_argument', {
  title: 'Get Oral Argument',
  description:
    'Fetch the full detail record for a single oral argument audio recording by its ID (the audio_id from courtlistener_search_oral_arguments). Returns the case name, panel judge IDs, duration, MP3 download URL, linked docket, and the speech-to-text transcript when transcription has completed. The argument date is not on this record — it comes from the search result or the linked docket.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    id: z
      .number()
      .int()
      .describe(
        'Audio recording ID — the audio_id field from a courtlistener_search_oral_arguments result.',
      ),
  }),

  output: z.object({
    oral_argument_id: z.number().describe('Audio recording ID.'),
    case_name: z.string().describe('Case name.'),
    case_name_full: z.string().describe('Full case name with parties.'),
    docket_id: z.number().describe('Associated docket ID; 0 if not linked.'),
    duration_seconds: z.number().describe('Recording duration in seconds.'),
    download_url: z.string().nullable().describe('Direct MP3 download URL; null if not available.'),
    judges: z.string().describe('Free-text judge names; often empty on this endpoint.'),
    panel_ids: z
      .array(z.number())
      .describe('Person IDs of panel judges — pass to courtlistener_get_judge.'),
    has_transcript: z.boolean().describe('True if a speech-to-text transcript is available.'),
    transcript: z
      .string()
      .describe('Speech-to-text transcript; empty string if transcription has not completed.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Audio ID does not exist in CourtListener.',
      recovery: 'Verify the audio ID from courtlistener_search_oral_arguments.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: '429 response from CourtListener.',
      retryable: true,
      recovery: 'Wait for the Retry-After period. Free tier: 5 req/min, 50/hr, 125/day.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_get_oral_argument', { id: input.id });
    const svc = getCourtListenerService();
    const audio = await svc.getOralArgument(input.id, ctx);

    // docket arrives as a resource URI — extract the numeric ID.
    let docketId = 0;
    if (audio.docket) {
      const match = audio.docket.match(/\/dockets\/(\d+)\//);
      if (match?.[1]) docketId = parseInt(match[1], 10);
    }

    const transcript = audio.stt_transcript ?? '';

    ctx.log.info('courtlistener_get_oral_argument complete', {
      id: input.id,
      has_transcript: transcript.length > 0,
    });

    return {
      oral_argument_id: audio.id,
      case_name: audio.case_name ?? '',
      case_name_full: audio.case_name_full ?? '',
      docket_id: docketId,
      duration_seconds: audio.duration ?? 0,
      download_url: audio.download_url ?? null,
      judges: audio.judges ?? '',
      panel_ids: audio.panel ?? [],
      has_transcript: transcript.length > 0,
      transcript,
    };
  },

  format: (result) => {
    const durationMin = Math.floor(result.duration_seconds / 60);
    const durationSec = result.duration_seconds % 60;
    const lines: string[] = [
      `## ${result.case_name}`,
      `**Audio ID:** ${result.oral_argument_id} | **Docket ID:** ${result.docket_id} | **Duration:** ${durationMin}m ${durationSec}s (${result.duration_seconds}s)`,
    ];

    if (result.case_name_full && result.case_name_full !== result.case_name) {
      lines.push(`*${result.case_name_full}*`);
    }
    if (result.judges) lines.push(`**Judges:** ${result.judges}`);
    if (result.panel_ids.length > 0) lines.push(`**Panel IDs:** ${result.panel_ids.join(', ')}`);
    if (result.download_url) lines.push(`**Download:** ${result.download_url}`);

    lines.push(`**Transcript available:** ${result.has_transcript ? 'yes' : 'no'}`);
    if (result.transcript) {
      const excerpt = result.transcript.slice(0, 3000);
      lines.push(
        `\n**Transcript:**\n${excerpt}${result.transcript.length > 3000 ? '\n\n*[transcript truncated]*' : ''}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
