/**
 * @fileoverview Fetch full detail for a single oral argument audio recording.
 * @module mcp-server/tools/definitions/get-oral-argument.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  DEFAULT_OUTLINE_BUDGET_BYTES,
  formatOutline,
  OUTLINE_VARIANT,
} from '@cyanheads/mcp-ts-core/utils';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import { idFromUri, personIdFromUri } from '@/services/courtlistener/uri.js';

/** The record's fields. Made optional in the tool output because `transcript` is the
 *  one field an outline response withholds; the rest accompany every response. */
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
    .describe(
      'Speech-to-text transcript; empty string if transcription has not completed. The only field an outline response withholds — re-call with sections:["transcript"] to retrieve it.',
    ),
});

/** Valid `sections` names — the record's own top-level keys, derived from the schema
 *  rather than restated. `transcript` is the only name that adds anything, since the
 *  rest accompany every response; a selection naming only the others is accepted and
 *  returns the record without the transcript. */
const SECTION_NAMES = Object.keys(OralArgumentDetail.shape);

export const getOralArgumentTool = tool('courtlistener_get_oral_argument', {
  title: 'Get Oral Argument',
  description:
    'Fetch the full detail record for a single oral argument audio recording by its ID (the audio_id from courtlistener_search_oral_arguments). Returns the case name, panel judge IDs, duration, MP3 download URL, linked docket, and the speech-to-text transcript when transcription has completed. A long transcript is withheld and listed as a retrievable section instead; re-call with sections:["transcript"] to pull it. Every other field is present either way. The argument date is not on this record — it comes from the search result or the linked docket.',
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
        'Section identifiers to retrieve, from a prior outline response — ["transcript"] is the only one that adds anything, since every other field is returned regardless. A selection that omits "transcript" therefore returns the record without it. Omit this argument entirely for the whole record, or the record minus an oversized transcript.',
      ),
  }),

  output: z.object({
    kind: z
      .enum(['full', 'outline'])
      .describe(
        "'full' carries the transcript inline; 'outline' withholds it and lists it as a retrievable section because it overflows the inline byte budget. Every other field of the record is present either way.",
      ),
    ...OralArgumentDetail.partial().shape,
    // Outline arm — reuses OUTLINE_VARIANT's shape. The section element carries an
    // object-level describe (the framework schema describes only name/bytes), and the
    // re-call notice is named retrieval_notice so it reads as domain data on this surface.
    sections: z
      .array(
        OUTLINE_VARIANT.shape.sections.element.describe(
          'A withheld section of the record and its serialized byte size.',
        ),
      )
      .optional()
      .describe(
        'Sections withheld from this response — only ever `transcript`; pass its name to `sections` on a re-call. Absent when nothing was withheld.',
      ),
    retrieval_notice: OUTLINE_VARIANT.shape.notice
      .optional()
      .describe('How to re-call the tool for the transcript when it overflows the inline budget.'),
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
      retryable: false,
      recovery:
        'Wait out the Retry-After interval reported on the error before calling again. CourtListener throttles per minute, hour, and day, so an immediate retry fails.',
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

    // Reject unknown section names before the network call. SECTION_NAMES is fixed at
    // module load (derived from the record schema), so a bad name never depends on the
    // fetched record — rejecting up front spends no upstream request (cf. #39/#40).
    // (get_opinion's equivalent can't hoist: its valid names are per-cluster.)
    if (input.sections?.length) {
      const unknown = input.sections.filter((name) => !SECTION_NAMES.includes(name));
      if (unknown.length > 0) {
        throw ctx.fail(
          'unknown_section',
          `Unknown sections value: ${unknown.join(', ')}. Valid sections: ${SECTION_NAMES.join(', ')}.`,
        );
      }
    }

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

    // Cheap record metadata — kept in every response, full or outline. The transcript
    // is the only field large enough to be worth withholding; the rest are scalars and
    // short arrays that cost nothing, and an outline without them tells the agent
    // neither which case it fetched nor what to chain to next.
    const meta = {
      oral_argument_id: audio.id,
      case_name: audio.case_name ?? '',
      case_name_full: audio.case_name_full ?? '',
      docket_id: docketId,
      duration_seconds: audio.duration ?? 0,
      download_url: audio.download_url ?? null,
      judges: audio.judges ?? '',
      panel_ids: panelIds,
      has_transcript: transcript.length > 0,
    };

    ctx.log.info('courtlistener_get_oral_argument complete', {
      id: input.id,
      has_transcript: meta.has_transcript,
    });

    // Selection re-call: the transcript is the only withheld field, so it is the only
    // name that adds anything. Unknown names were already rejected before the fetch.
    if (input.sections?.length) {
      return {
        ...meta,
        ...(input.sections.includes('transcript') ? { transcript } : {}),
        kind: 'full' as const,
      };
    }

    // Disclosure path. `outlineOnOverflow` can't drive this: it short-circuits to the
    // full document whenever fewer than two sections are extracted, so scoping it to
    // the transcript alone would inline every oversized transcript — the exact payload
    // the outline arm exists to avoid. Measure the one field against the same budget
    // and build the single-section outline directly.
    const transcriptBytes = JSON.stringify(transcript).length;
    if (transcriptBytes > DEFAULT_OUTLINE_BUDGET_BYTES) {
      return {
        ...meta,
        kind: 'outline' as const,
        sections: [{ name: 'transcript', bytes: transcriptBytes }],
        retrieval_notice:
          'Transcript too large to inline. Re-call courtlistener_get_oral_argument with the same id plus sections:["transcript"] to retrieve it in full. Every other field of the record is already in this response.',
      };
    }
    return { ...meta, transcript, kind: 'full' as const };
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

    // Record metadata accompanies both arms, so this header renders in every mode.
    // `kind` is required in every response and renders unconditionally — keying it off
    // an arm would hide the discriminator from content[]-only clients.
    const lines: string[] = [`## ${result.case_name ?? ''}`, `**Response mode:** ${result.kind}`];

    const meta: string[] = [];
    if (result.oral_argument_id !== undefined)
      meta.push(`**Audio ID:** ${result.oral_argument_id}`);
    if (result.docket_id !== undefined) meta.push(`**Docket ID:** ${result.docket_id}`);
    if (result.duration_seconds !== undefined) {
      const durationMin = Math.floor(result.duration_seconds / 60);
      const durationSec = result.duration_seconds % 60;
      meta.push(`**Duration:** ${durationMin}m ${durationSec}s (${result.duration_seconds}s)`);
    }
    if (meta.length > 0) lines.push(meta.join(' | '));

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
