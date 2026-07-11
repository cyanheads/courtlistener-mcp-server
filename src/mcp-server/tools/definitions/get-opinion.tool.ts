/**
 * @fileoverview Fetch full text and metadata for a single CourtListener opinion cluster.
 * @module mcp-server/tools/definitions/get-opinion.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatOutline, OUTLINE_VARIANT, outlineOnOverflow } from '@cyanheads/mcp-ts-core/utils';
import { resolveCourtName } from '@/services/courtlistener/court-names.js';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import { idFromUri } from '@/services/courtlistener/uri.js';

/** A single opinion variant within a cluster. Optional in the tool output: the
 *  full arm carries them all; on overflow they're replaced by a section outline. */
const OpinionVariant = z
  .object({
    id: z.number().describe('Individual opinion ID.'),
    type: z
      .string()
      .describe('Opinion type: "lead-opinion", "concurrence", "dissent", "combined-opinion", etc.'),
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
    plain_text: z.string().describe('Plain text version of the opinion; may be empty.'),
    cites: z.array(z.number()).describe('Opinion IDs this opinion cites.'),
    download_url: z
      .string()
      .nullable()
      .describe('Direct download URL for the original opinion document; null if not available.'),
  })
  .describe('Individual opinion variant.');

export const getOpinionTool = tool('courtlistener_get_opinion', {
  title: 'Get Court Opinion',
  description:
    'Fetch the full text and metadata for a single opinion cluster by cluster ID. A cluster groups all opinions filed in a case — majority, concurrence, dissent, and per curiam. Returns the cluster metadata (case name, court, citations, dates) plus every opinion variant with HTML and plain text. When the combined opinion text is too large to inline, the response lists each variant as a retrievable section (opinion_<id>) while keeping the cheap cluster metadata — re-call with sections:[...] to pull specific variants in full. Obtain cluster IDs from courtlistener_search_opinions, courtlistener_lookup_citation, or docket results.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
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
        'Opinion variant identifiers to retrieve in full, from a prior outline response (e.g. ["opinion_12345"]). Omit to return all variants, or an outline if they overflow the inline byte budget.',
      ),
  }),

  output: z.object({
    // Cheap cluster metadata — always present, in both full and outline responses.
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
      .enum(['full', 'outline'])
      .describe(
        "'full' returns the opinion variants (all, or a selected subset); 'outline' lists each variant as a retrievable section (opinion_<id>) when the opinions overflow the inline byte budget. Cluster metadata is present either way.",
      ),
    // Full arm — every opinion variant. Omitted in outline mode.
    opinions: z
      .array(OpinionVariant)
      .optional()
      .describe(
        'All opinion variants within this cluster. Present in full mode; omitted in outline mode — re-call with sections:["opinion_<id>"] to retrieve specific variants.',
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
        'Retrievable opinion variants, largest first — pass names to `sections` on a re-call.',
      ),
    retrieval_notice: OUTLINE_VARIANT.shape.notice
      .optional()
      .describe(
        'How to re-call the tool for specific opinion variants when the opinions overflow.',
      ),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Cluster ID does not exist in CourtListener.',
      recovery:
        'Verify the cluster ID from courtlistener_search_opinions or courtlistener_lookup_citation.',
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
    if (docketId) {
      try {
        const summary = await svc.getDocketSummary(docketId, ctx);
        courtId ||= summary.court_id;
        docketNumber ||= summary.docket_number;
      } catch (err) {
        ctx.log.debug('docket summary backfill failed', { docketId, err: String(err) });
      }
    }

    const opinions = (cluster.sub_opinions ?? []).map((op) => ({
      id: op.id,
      type: op.type ?? '',
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
      plain_text: op.plain_text ?? '',
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

    // Cheap cluster metadata — kept in every response, full or outline. The overflow
    // primitive drops all fields but kind/sections/notice, so these are merged back on.
    const clusterMeta = {
      cluster_id: cluster.id,
      case_name: cluster.case_name ?? '',
      case_name_full: cluster.case_name_full ?? '',
      court: resolveCourtName(courtId),
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
    if (input.sections?.length) {
      const wanted = new Set(input.sections);
      const selected = opinions.filter((op) => wanted.has(`opinion_${op.id}`));
      return { ...clusterMeta, opinions: selected, kind: 'full' as const };
    }

    // Disclosure path: outline scoped to the opinions sub-collection so each variant
    // is its own section (opinion_<id>). The default extractor would treat the whole
    // `opinions` array as one unsplittable section, so override it.
    const overflow = outlineOnOverflow(
      { opinions },
      {
        extract: (doc) =>
          doc.opinions.map((op) => ({
            name: `opinion_${op.id}`,
            bytes: JSON.stringify(op).length,
          })),
        notice: (sections) =>
          `Opinion text too large to inline. Re-call courtlistener_get_opinion with the same cluster_id plus sections:[...] to retrieve specific opinion variants — e.g. ${sections
            .slice(0, 3)
            .map((s) => s.name)
            .join(
              ', ',
            )}. Cluster metadata (case name, court, citations, syllabus) is included in every response.`,
      },
    );

    if (overflow.kind === 'outline') {
      return {
        ...clusterMeta,
        kind: 'outline' as const,
        sections: overflow.sections,
        retrieval_notice: overflow.notice,
      };
    }
    return { ...clusterMeta, opinions: overflow.opinions, kind: 'full' as const };
  },

  format: (result) => {
    // Cheap cluster metadata — always present, so this header renders in every mode.
    const lines: string[] = [
      `## ${result.case_name}`,
      `**Cluster ID:** ${result.cluster_id} | **Court:** ${result.court} (${result.court_id}) | **Filed:** ${result.date_filed}`,
      `**Docket:** ${result.docket_number} (ID: ${result.docket_id}) | **Status:** ${result.precedential_status} | **Cited by:** ${result.cite_count}`,
    ];

    if (result.case_name_full && result.case_name_full !== result.case_name) {
      lines.push(`*${result.case_name_full}*`);
    }
    if (result.citations.length > 0) {
      lines.push(`**Citations:** ${result.citations.join(', ')}`);
    }
    if (result.judges) lines.push(`**Judges:** ${result.judges}`);
    if (result.syllabus) lines.push(`\n**Syllabus:** ${result.syllabus}`);
    if (result.posture) lines.push(`**Posture:** ${result.posture}`);

    // Full arm — opinion variants. Guarded so outline mode (opinions omitted) skips it.
    for (const op of result.opinions ?? []) {
      lines.push(`\n### Opinion (${op.type})`);
      lines.push(`**ID:** ${op.id} | **Per Curiam:** ${op.per_curiam ? 'Yes' : 'No'}`);
      if (op.author_id != null) lines.push(`**Author ID:** ${op.author_id}`);
      if (op.cites.length > 0) lines.push(`**Cites:** ${op.cites.join(', ')}`);
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
