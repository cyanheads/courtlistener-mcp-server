/**
 * @fileoverview Fetch full text and metadata for a single CourtListener opinion cluster.
 * @module mcp-server/tools/definitions/get-opinion.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { formatOutline, OUTLINE_VARIANT } from '@cyanheads/mcp-ts-core/utils';
import { expandCode } from '@/services/courtlistener/codes.js';
import { resolveCourtName } from '@/services/courtlistener/court-names.js';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import { Completion } from '@/services/courtlistener/page-metadata.js';
import { presentation, readableText } from '@/services/courtlistener/readable-text.js';
import {
  formatRetrievalPage,
  Retrieval,
  RetrievalCursor,
  readRetrievalCursor,
  retrieve,
} from '@/services/courtlistener/retrieval.js';
import { idFromUri } from '@/services/courtlistener/uri.js';

/**
 * CourtListener's `o_type_index_map` (cl/search/constants.py) → the labels the search
 * index serves, via `OpinionDocument.prepare_type`. `/opinions/` returns the stored
 * code instead, whose numeric prefix is a sort key rather than part of the type, so
 * this is the mapping that makes get_opinion and search_opinions agree on one opinion.
 */
const OPINION_TYPE_LABELS: Record<string, string> = {
  '010combined': 'combined-opinion',
  '015unamimous': 'unanimous-opinion',
  '020lead': 'lead-opinion',
  '025plurality': 'plurality-opinion',
  '030concurrence': 'concurrence-opinion',
  '035concurrenceinpart': 'in-part-opinion',
  '040dissent': 'dissent',
  '050addendum': 'addendum',
  '060remittitur': 'remittitur',
  '070rehearing': 'rehearing',
  '080onthemerits': 'on-the-merits',
  '090onmotiontostrike': 'on-motion-to-strike',
  '100trialcourt': 'trial-court-document',
};

/** A variant stays typed on partial pages; text omitted there follows field paths. */
const OpinionVariant = z
  .object({
    id: z.number().describe('Individual opinion ID.'),
    type: z
      .string()
      .describe(
        'Raw CourtListener opinion-type code (e.g. "030concurrence"); the numeric prefix is a sort key, not part of the type. Empty when upstream recorded none.',
      ),
    type_label: z
      .string()
      .describe(
        'Opinion type expanded to the label courtlistener_search_opinions serves for the same variant: "lead-opinion", "concurrence-opinion", "dissent", "combined-opinion", etc. An unmapped code passes through as the code itself.',
      ),
    author_id: z
      .number()
      .nullable()
      .describe('Person ID of the author; null if per curiam or unknown.'),
    per_curiam: z.boolean().describe('True if this is a per curiam opinion.'),
    html_text: z
      .string()
      .describe(
        'Full opinion text as HTML, drawn from the best available variant (citation-linked when present); empty only when no HTML text is stored — use download_url then.',
      ),
    plain_text: z
      .string()
      .describe(
        'Supplied plain text preserved exactly, or readable text derived from source markup when absent; empty if neither exists.',
      ),
    cites: z.array(z.number()).describe('Opinion IDs this opinion cites.'),
    download_url: z
      .string()
      .nullable()
      .describe('Direct download URL for the original opinion document; null if not available.'),
  })
  .partial({
    type: true,
    type_label: true,
    html_text: true,
    plain_text: true,
    download_url: true,
    cites: true,
  })
  .describe(
    'Individual opinion variant; omitted partial fields are recoverable through retrieval.',
  );

export const getOpinionTool = tool('courtlistener_get_opinion', {
  title: 'Get Court Opinion',
  description:
    'Fetch text and metadata for an opinion cluster by cluster ID. Returns majority, concurrence and dissent variants with raw HTML and readable plain text, variants_completion for source coverage, and docket_enrichment. Oversized selections return outline then page responses; continue retrieval.next_cursor as cursor with the unchanged ID/sections selection until null. Obtain cluster IDs from courtlistener_search_opinions, courtlistener_lookup_citation, or docket results.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    cursor: RetrievalCursor,
    cluster_id: z
      .number()
      .int()
      .describe(
        'Opinion cluster ID — identifies a case decision and groups all opinion variants (majority, concurrence, dissent). Obtain from courtlistener_search_opinions, courtlistener_lookup_citation, or from docket results that link to opinions.',
      ),
    sections: z
      .array(z.string())
      .optional()
      .describe(
        'Opinion variant identifiers to select (e.g. ["opinion_12345"]). Omit for all fetched variants. Oversized selections page; keep this selection unchanged while following cursor.',
      ),
  }),

  output: z
    .object({
      retrieval: Retrieval,
      variants_completion: Completion.partial({ next_cursor: true })
        .optional()
        .describe(
          'Source-walk completion. An oversized upstream next_cursor is omitted on partial responses and recovered at /variants_completion/next_cursor through retrieval.text_chunks.',
        ),
      docket_enrichment: z
        .object({
          status: z
            .enum(['not_linked', 'resolved', 'source_fields_absent', 'lookup_failed'])
            .describe('Outcome of the optional linked-docket lookup.'),
          error_code: z
            .number()
            .optional()
            .describe('Sanitized MCP error code when the lookup failed.'),
          reason: z
            .enum(['not_found', 'lookup_failed'])
            .optional()
            .describe('Safe lookup failure category, without upstream error text.'),
        })
        .optional()
        .describe('Linked-docket enrichment outcome, independent of opinion text availability.'),
      // Bounded identity stays present; oversized metadata is recoverable by path.
      cluster_id: z.number().describe('Opinion cluster ID.'),
      case_name: z.string().describe('Short case name.'),
      case_name_full: z.string().describe('Full case name with parties.'),
      court: z.string().describe('Court display name.'),
      court_id: z.string().describe('Court identifier.'),
      date_filed: z.string().describe('Date the opinion was filed.'),
      docket_id: z.number().describe('Associated docket ID.'),
      docket_number: z.string().describe('Docket number.'),
      judges: z.string().describe('Judge names.'),
      citations: z.array(z.string()).describe('All known citation strings for this case.'),
      cite_count: z.number().describe('Total number of citations from other opinions.'),
      precedential_status: z.string().describe('Publication/precedential status.'),
      syllabus: z.string().describe('Syllabus text (may be empty).'),
      posture: z.string().describe('Procedural posture (may be empty).'),
      kind: z
        .enum(['full', 'outline', 'page'])
        .describe(
          "'full' carries a small selected record; 'outline' pages the section catalog; 'page' carries typed rows and field-path text chunks. Bounded identity remains present throughout retrieval.",
        ),
      // Full arm — every opinion variant. Omitted in outline mode.
      opinions: z
        .array(OpinionVariant)
        .optional()
        .describe(
          'Fetched variants; variants_completion describes source coverage. Pages can contain partial typed variants; omitted text is recoverable through retrieval.text_chunks at original field paths.',
        ),
      // Outline arm — one section per opinion variant. Reuses OUTLINE_VARIANT's shape;
      // the section element gets an object-level describe (the framework schema describes
      // only name/bytes) and the re-call notice is named retrieval_notice to read as
      // domain data (a field literally named `notice` reads as agent-facing context).
      sections: z
        .array(
          OUTLINE_VARIANT.shape.sections.element.describe(
            'A retrievable opinion variant (opinion_<id>) and its serialized byte size.',
          ),
        )
        .optional()
        .describe(
          'Section catalog in source order, including paged metadata. Only opinion_<id> names select variants; follow retrieval.next_cursor to finish the catalog and retrieve data.',
        ),
      retrieval_notice: OUTLINE_VARIANT.shape.notice
        .optional()
        .describe('How to continue bounded retrieval using the unchanged ID and selection.'),
    })
    .partial({
      case_name: true,
      case_name_full: true,
      court: true,
      court_id: true,
      date_filed: true,
      docket_number: true,
      judges: true,
      precedential_status: true,
      syllabus: true,
      posture: true,
      citations: true,
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
      when: 'Cluster ID does not exist in CourtListener.',
      recovery:
        'Verify the cluster ID from courtlistener_search_opinions or courtlistener_lookup_citation.',
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
      when: 'A requested sections name matches no opinion variant in this cluster.',
      recovery:
        'Re-call without sections to list the retrievable opinion_<id> names, then request one of those.',
    },
  ],

  async handler(input, ctx) {
    const cursor = readRetrievalCursor(input.cursor, 'opinion', input.cluster_id, input.sections);
    ctx.log.info('courtlistener_get_opinion', { cluster_id: input.cluster_id });
    const svc = getCourtListenerService();
    const cluster = await svc.getOpinionCluster(input.cluster_id, ctx);

    // Normalize citation strings
    const citations = (cluster.citations ?? []).map((c) => `${c.volume} ${c.reporter} ${c.page}`);

    // Extract docket_id from the docket resource URI if not directly provided
    let docketId = cluster.docket_id ?? 0;
    if (!docketId && cluster.docket) {
      docketId = idFromUri(cluster.docket, 'dockets') ?? 0;
    }

    // /clusters/{id}/ omits court_id and docket_number — backfill from the linked
    // docket (one extra call, non-fatal so a docket miss never fails the opinion fetch).
    let courtId = cluster.court_id ?? '';
    let docketNumber = cluster.docket_number ?? '';
    let docketEnrichment: {
      status: 'not_linked' | 'resolved' | 'source_fields_absent' | 'lookup_failed';
      error_code?: number;
      reason?: 'not_found' | 'lookup_failed';
    } = { status: 'not_linked' };
    if (docketId) {
      try {
        const summary = await svc.getDocketSummary(docketId, ctx);
        courtId ||= summary.court_id;
        docketNumber ||= summary.docket_number;
        docketEnrichment = {
          status: summary.court_id && summary.docket_number ? 'resolved' : 'source_fields_absent',
        };
      } catch (err) {
        if (
          ctx.signal?.aborted ||
          (err instanceof McpError && err.code === JsonRpcErrorCode.RequestCancelled) ||
          (err instanceof Error && err.name === 'AbortError')
        )
          throw err;
        const code = err instanceof McpError ? err.code : JsonRpcErrorCode.ServiceUnavailable;
        docketEnrichment = {
          status: 'lookup_failed',
          error_code: code,
          reason: code === JsonRpcErrorCode.NotFound ? 'not_found' : 'lookup_failed',
        };
        ctx.log.debug('docket summary backfill failed', { docketId, code });
      }
    }

    const opinions = (cluster.sub_opinions ?? []).map((op) => ({
      id: op.id,
      type: op.type ?? '',
      type_label: expandCode(OPINION_TYPE_LABELS, op.type),
      author_id: op.author_id ?? null,
      per_curiam: op.per_curiam ?? false,
      // CourtListener spreads opinion text across source-dependent variant fields;
      // `html` is often empty (e.g. pre-2000 case law) while `html_with_citations`
      // carries the full text. Fall back across variants, preferring the richest.
      html_text:
        op.html_with_citations ||
        op.html ||
        op.html_columbia ||
        op.html_lawbox ||
        op.xml_harvard ||
        op.html_anon_2020 ||
        '',
      plain_text:
        op.plain_text ||
        readableText(
          op.html_with_citations ||
            op.html ||
            op.html_columbia ||
            op.html_lawbox ||
            op.xml_harvard ||
            op.html_anon_2020 ||
            '',
        ),
      // opinions_cited are URI strings — extract the numeric ID from each
      cites: (op.opinions_cited ?? []).flatMap((uri) => {
        const id = idFromUri(String(uri), 'opinions');
        return id !== null ? [id] : [];
      }),
      download_url: op.download_url ?? null,
    }));

    ctx.log.info('courtlistener_get_opinion complete', {
      cluster_id: input.cluster_id,
      opinions_count: opinions.length,
    });

    // Normalize metadata before hashing and slicing the selected view.
    const clusterMeta = {
      cluster_id: cluster.id,
      variants_completion: cluster.variants_completion,
      docket_enrichment: docketEnrichment,
      case_name: cluster.case_name ?? '',
      case_name_full: cluster.case_name_full ?? '',
      court: courtId ? resolveCourtName(courtId) : (cluster.court ?? ''),
      court_id: courtId,
      date_filed: cluster.date_filed ?? '',
      docket_id: docketId,
      docket_number: docketNumber,
      judges: cluster.judges ?? '',
      citations,
      cite_count: cluster.citation_count ?? 0,
      precedential_status: cluster.precedential_status ?? '',
      syllabus: cluster.syllabus ?? '',
      posture: cluster.posture ?? '',
    };

    // Selection re-call: return only the requested opinion variants, keyed by section id.
    // Valid names are generated per cluster (opinion_<id>) from the variants this
    // cluster actually has, so they can't be a static input enum — reject unmatched
    // names here rather than silently returning a full response with nothing in it.
    let selected = opinions;
    if (input.sections?.length) {
      const available = opinions.map((op) => `opinion_${op.id}`);
      const unknown = input.sections.filter((name) => !available.includes(name));
      if (unknown.length > 0) {
        const known =
          available.length > 0
            ? `Retrievable variants for cluster ${input.cluster_id}: ${available.join(', ')}.`
            : `Cluster ${input.cluster_id} has no opinion variants.`;
        throw ctx.fail(
          'unknown_section',
          `Unknown sections value: ${unknown.join(', ')}. ${known}`,
        );
      }
      const wanted = new Set(input.sections);
      selected = opinions.filter((op) => wanted.has(`opinion_${op.id}`));
    }

    return retrieve({
      tool: 'opinion',
      id: input.cluster_id,
      selection: input.sections,
      cursor,
      view: { ...clusterMeta, opinions: selected },
      groups: selected.map((op) => ({ name: `opinion_${op.id}`, value: op })),
      required: [
        'cluster_id',
        'docket_id',
        'cite_count',
        'variants_completion',
        'docket_enrichment',
      ],
      signal: ctx.signal,
      finalize: finalizeOpinion,
    });
  },

  format: (result) => {
    if (result.retrieval) return formatRetrievalPage(result);
    result = presentation(result);
    // Cheap cluster metadata — always present, so this header renders in every mode.
    // `kind` is rendered unconditionally: it's required in every response, so keying
    // it off an arm would hide the discriminator from content[]-only clients.
    const lines: string[] = [
      `## ${result.case_name}`,
      `**Cluster ID:** ${result.cluster_id} | **Court:** ${result.court} (${result.court_id}) | **Filed:** ${result.date_filed}`,
      `**Docket:** ${result.docket_number} (ID: ${result.docket_id}) | **Status:** ${result.precedential_status} | **Cited by:** ${result.cite_count}`,
      `**Response mode:** ${result.kind}`,
      ...(result.variants_completion
        ? [
            `**Variants:** complete=${result.variants_completion.complete}; upstream variant cursor=${result.variants_completion.next_cursor ?? 'none'}.`,
          ]
        : []),
      ...(result.docket_enrichment
        ? [
            `**Docket enrichment:** ${result.docket_enrichment.status}; error code=${result.docket_enrichment.error_code ?? 'none'}; reason=${result.docket_enrichment.reason ?? 'none'}.`,
          ]
        : []),
    ];

    if (result.case_name_full && result.case_name_full !== result.case_name) {
      lines.push(`*${result.case_name_full}*`);
    }
    if (result.citations?.length) {
      lines.push(`**Citations:** ${result.citations.join(', ')}`);
    }
    if (result.judges) lines.push(`**Judges:** ${result.judges}`);
    if (result.syllabus) lines.push(`\n**Syllabus:** ${result.syllabus}`);
    if (result.posture) lines.push(`**Posture:** ${result.posture}`);

    // Full arm — opinion variants. Guarded so outline mode (opinions omitted) skips it.
    for (const op of result.opinions ?? []) {
      lines.push(`\n### Opinion (${op.type_label})`);
      lines.push(
        `**ID:** ${op.id} | **Type code:** ${op.type} | **Per Curiam:** ${op.per_curiam ? 'Yes' : 'No'}`,
      );
      if (op.author_id != null) lines.push(`**Author ID:** ${op.author_id}`);
      if (op.cites?.length) lines.push(`**Cites:** ${op.cites.join(', ')}`);
      if (op.download_url) lines.push(`**Download:** ${op.download_url}`);

      // Full opinion text — no truncation; overflow is handled by the outline arm.
      // plain_text is shown first as it is typically cleaner.
      if (op.plain_text) lines.push(`\n${op.plain_text}`);
      if (op.html_text) lines.push(`\n**html_text:** ${op.html_text}`);
      if (!op.plain_text && !op.html_text && op.download_url) {
        lines.push(
          `\n*Opinion text not stored locally. Use download_url to retrieve the document.*`,
        );
      }
    }

    // Outline arm — rendered whenever `sections` is present (independent of `kind`).
    const outlineBlocks = result.sections
      ? formatOutline({
          kind: 'outline',
          sections: result.sections,
          notice: result.retrieval_notice ?? '',
        })
      : [];

    return [{ type: 'text', text: lines.join('\n') }, ...outlineBlocks];
  },
});

/** No enrichment or collected media is declared here: parse + format is the complete success wire. */
function finalizeOpinion(value: unknown): { structuredContent: object; content: unknown[] } {
  const parsed = getOpinionTool.output.parse(value);
  const format = getOpinionTool.format;
  if (!format) throw new Error('Bounded retrieval requires the production formatter.');
  return { structuredContent: parsed, content: format(parsed) };
}
