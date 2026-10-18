/**
 * @fileoverview Fetch full detail for a single oral argument audio recording.
 * @module mcp-server/tools/definitions/get-oral-argument.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatOutline, OUTLINE_VARIANT } from '@cyanheads/mcp-ts-core/utils';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import { presentation } from '@/services/courtlistener/readable-text.js';
import {
  formatRetrievalPage,
  Retrieval,
  RetrievalCursor,
  readRetrievalCursor,
  retrieve,
} from '@/services/courtlistener/retrieval.js';
import { idFromUri, personIdFromUri } from '@/services/courtlistener/uri.js';

/** Record fields; optional output fields remain recoverable through page paths. */
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
      'Speech-to-text transcript; empty if transcription has not completed. Oversized text is recovered through retrieval.text_chunks at /transcript.',
    ),
});

/** Existing selection vocabulary: metadata stays selected; transcript can be excluded. */
const SECTION_NAMES = Object.keys(OralArgumentDetail.shape);

export const getOralArgumentTool = tool('courtlistener_get_oral_argument', {
  title: 'Get Oral Argument',
  description:
    'Fetch an oral argument recording by audio_id from courtlistener_search_oral_arguments. Returns case metadata, panel IDs, duration, MP3 URL, docket and available transcript. Oversized text or metadata returns outline then page responses; continue retrieval.next_cursor as cursor with the unchanged ID/sections selection until null. The argument date comes from search or the linked docket.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    cursor: RetrievalCursor,
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
        'Selected record fields. Metadata is always selected; a nonempty selection omitting transcript excludes it. Omit for the whole record. Oversized selections page; keep this selection unchanged while following cursor.',
      ),
  }),

  output: z.object({
    retrieval: Retrieval,
    kind: z
      .enum(['full', 'outline', 'page'])
      .describe(
        "'full' carries a small selected record; 'outline' pages the section catalog; 'page' carries fields and text chunks. Bounded identity remains present throughout retrieval.",
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
        'Section catalog: transcript and paged metadata fields. Follow retrieval.next_cursor to finish the catalog and retrieve data.',
      ),
    retrieval_notice: OUTLINE_VARIANT.shape.notice
      .optional()
      .describe('How to continue bounded retrieval using the unchanged ID and selection.'),
  }),

  errors: [
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Retrieval cursor is malformed, out of range or belongs to another request.',
      recovery: 'Restart without cursor using the original ID and selection.',
      thrownBy: 'service',
    },
    {
      reason: 'stale_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The normalized selected source changed since the previous page.',
      recovery: 'Restart without cursor to retrieve the current source consistently.',
      thrownBy: 'service',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Audio ID does not exist in CourtListener.',
      recovery: 'Verify the audio ID from courtlistener_search_oral_arguments.',
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: '429 from CourtListener, or no request slot opened within the wait budget.',
      retryable: false,
      recovery:
        'Wait out the Retry-After interval reported on the error before calling again. CourtListener throttles per minute, hour, and day, so an immediate retry fails.',
      thrownBy: 'service',
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
    const cursor = readRetrievalCursor(input.cursor, 'audio', input.id, input.sections);
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

    // Normalize metadata before measuring the selected view.
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

    const includeTranscript = !input.sections?.length || input.sections.includes('transcript');
    return retrieve({
      tool: 'audio',
      id: input.id,
      selection: input.sections,
      cursor,
      view: { ...meta, ...(includeTranscript ? { transcript } : {}) },
      groups: includeTranscript ? [{ name: 'transcript', value: transcript }] : [],
      required: ['oral_argument_id', 'docket_id', 'duration_seconds', 'has_transcript'],
      signal: ctx.signal,
      finalize: finalizeAudio,
    });
  },

  format: (result) => {
    if (result.retrieval) return formatRetrievalPage(result);
    result = presentation(result);
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

/** No enrichment or collected media is declared here: parse + format is the complete success wire. */
function finalizeAudio(value: unknown): { structuredContent: object; content: unknown[] } {
  const parsed = getOralArgumentTool.output.parse(value);
  const format = getOralArgumentTool.format;
  if (!format) throw new Error('Bounded retrieval requires the production formatter.');
  return { structuredContent: parsed, content: format(parsed) };
}
