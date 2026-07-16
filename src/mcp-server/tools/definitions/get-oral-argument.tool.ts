/**
 * @fileoverview Fetch full detail for a single oral argument audio recording.
 * @module mcp-server/tools/definitions/get-oral-argument.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  formatOutline,
  OUTLINE_VARIANT,
  outlineOnOverflow,
  selectSections,
} from '@cyanheads/mcp-ts-core/utils';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import { idFromUri, personIdFromUri } from '@/services/courtlistener/uri.js';

/** Full-mode fields — the record itself. Made optional in the tool output so an
 *  outline (or a section-scoped re-call) can omit the fields it doesn't carry. */
const OralArgumentDetail = z.object({
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
});

/** The only valid `sections` names: `selectSections` projects on the record's own
 *  top-level keys, so derive them from the schema rather than restating the list. */
const SECTION_NAMES = Object.keys(OralArgumentDetail.shape);

export const getOralArgumentTool = tool('courtlistener_get_oral_argument', {
  title: 'Get Oral Argument',
  description:
    'Fetch the full detail record for a single oral argument audio recording by its ID (the audio_id from courtlistener_search_oral_arguments). Returns the case name, panel judge IDs, duration, MP3 download URL, linked docket, and the speech-to-text transcript when transcription has completed. A long transcript overflows to a section outline; re-call with sections:["transcript"] to retrieve it in full. The argument date is not on this record — it comes from the search result or the linked docket.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    id: z
      .number()
      .int()
      .describe(
        'Audio recording ID — the audio_id field from a courtlistener_search_oral_arguments result.',
      ),
    sections: z
      .array(z.string())
      .optional()
      .describe(
        'Section identifiers to retrieve in full, from a prior outline response (e.g. ["transcript"]). Omit for the full record, or an outline if it overflows the inline budget.',
      ),
  }),

  output: z.object({
    kind: z
      .enum(['full', 'outline'])
      .describe(
        "'full' returns the record (or the selected sections); 'outline' lists retrievable sections when the transcript overflows the inline byte budget.",
      ),
    ...OralArgumentDetail.partial().shape,
    // Outline arm — reuses OUTLINE_VARIANT's shape. The section element carries an
    // object-level describe (the framework schema describes only name/bytes), and the
    // re-call notice is named retrieval_notice so it reads as domain data on this surface.
    sections: z
      .array(
        OUTLINE_VARIANT.shape.sections.element.describe(
          'A retrievable section of the record and its serialized byte size.',
        ),
      )
      .optional()
      .describe('Retrievable sections, largest first — pass names to `sections` on a re-call.'),
    retrieval_notice: OUTLINE_VARIANT.shape.notice
      .optional()
      .describe('How to re-call the tool for specific sections when the record overflows.'),
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
    {
      reason: 'unknown_section',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A requested sections name is not a field of the oral argument record.',
      recovery:
        'Pass a section name the outline listed, such as transcript, or omit sections entirely.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_get_oral_argument', { id: input.id });
    const svc = getCourtListenerService();
    const audio = await svc.getOralArgument(input.id, ctx);

    // docket arrives as a resource URI — extract the numeric ID.
    let docketId = 0;
    if (audio.docket) {
      docketId = idFromUri(audio.docket, 'dockets') ?? 0;
    }

    const transcript = audio.stt_transcript ?? '';

    // panel arrives as person resource URIs (/people/{id}/) — extract the numeric
    // IDs, dropping any that don't parse. Mirrors the docket + opinions_cited extraction.
    const panelIds = (audio.panel ?? []).flatMap((uri) => {
      const id = personIdFromUri(String(uri));
      return id !== null ? [id] : [];
    });

    const detail = {
      oral_argument_id: audio.id,
      case_name: audio.case_name ?? '',
      case_name_full: audio.case_name_full ?? '',
      docket_id: docketId,
      duration_seconds: audio.duration ?? 0,
      download_url: audio.download_url ?? null,
      judges: audio.judges ?? '',
      panel_ids: panelIds,
      has_transcript: transcript.length > 0,
      transcript,
    };

    ctx.log.info('courtlistener_get_oral_argument complete', {
      id: input.id,
      has_transcript: detail.has_transcript,
    });

    // Selection re-call: return only the requested sections plus identity fields.
    // selectSections silently drops names that match no key, which would return a
    // `full` response carrying nothing the caller asked for — reject them instead.
    if (input.sections?.length) {
      const unknown = input.sections.filter((name) => !SECTION_NAMES.includes(name));
      if (unknown.length > 0) {
        throw ctx.fail(
          'unknown_section',
          `Unknown sections value: ${unknown.join(', ')}. Valid sections: ${SECTION_NAMES.join(', ')}.`,
        );
      }
      return {
        ...selectSections(detail, input.sections, {
          alwaysKeep: ['oral_argument_id', 'case_name'],
        }),
        kind: 'full' as const,
      };
    }

    // Disclosure path: the whole record under budget, else a section outline. The
    // transcript is the one dominant field among small scalars, so the framework's
    // default extractor (one section per top-level key) needs no customization.
    const overflow = outlineOnOverflow(detail);
    if (overflow.kind === 'outline') {
      return {
        kind: 'outline' as const,
        sections: overflow.sections,
        retrieval_notice: overflow.notice,
      };
    }
    return overflow;
  },

  format: (result) => {
    // Outline arm — rendered whenever `sections` is present (independent of `kind`).
    const outlineBlocks = result.sections
      ? formatOutline({
          kind: 'outline',
          sections: result.sections,
          notice: result.retrieval_notice ?? '',
        })
      : [];

    // `kind` is required in every response, so it renders on both paths — a pure
    // outline drops every record field and would otherwise show no discriminator.
    const modeLine = `**Response mode:** ${result.kind}`;

    // Full arm — keyed on oral_argument_id (always kept). Each field is guarded
    // because a section-scoped re-call returns a partial record.
    if (result.oral_argument_id === undefined) {
      return [{ type: 'text', text: modeLine }, ...outlineBlocks];
    }

    const lines: string[] = [`## ${result.case_name ?? ''}`, modeLine];

    const meta: string[] = [`**Audio ID:** ${result.oral_argument_id}`];
    if (result.docket_id !== undefined) meta.push(`**Docket ID:** ${result.docket_id}`);
    if (result.duration_seconds !== undefined) {
      const durationMin = Math.floor(result.duration_seconds / 60);
      const durationSec = result.duration_seconds % 60;
      meta.push(`**Duration:** ${durationMin}m ${durationSec}s (${result.duration_seconds}s)`);
    }
    lines.push(meta.join(' | '));

    if (result.case_name_full && result.case_name_full !== result.case_name) {
      lines.push(`*${result.case_name_full}*`);
    }
    if (result.judges) lines.push(`**Judges:** ${result.judges}`);
    if (result.panel_ids && result.panel_ids.length > 0) {
      lines.push(`**Panel IDs:** ${result.panel_ids.join(', ')}`);
    }
    if (result.download_url) lines.push(`**Download:** ${result.download_url}`);
    if (result.has_transcript !== undefined) {
      lines.push(`**Transcript available:** ${result.has_transcript ? 'yes' : 'no'}`);
    }
    // Full transcript — no truncation; overflow is handled by the outline arm above.
    if (result.transcript) lines.push(`\n**Transcript:**\n${result.transcript}`);

    return [{ type: 'text', text: lines.join('\n') }, ...outlineBlocks];
  },
});
