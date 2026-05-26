/**
 * @fileoverview Fetch full text and metadata for a single CourtListener opinion cluster.
 * @module mcp-server/tools/definitions/get-opinion.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

export const getOpinionTool = tool('courtlistener_get_opinion', {
  title: 'Get Court Opinion',
  description:
    'Fetch the full text and metadata for a single opinion cluster by cluster ID. A cluster groups all opinions filed in a case — majority, concurrence, dissent, and per curiam. Returns all opinion variants with HTML and plain text. Obtain cluster IDs from courtlistener_search_opinions, courtlistener_lookup_citation, or docket results.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    cluster_id: z
      .number()
      .int()
      .describe(
        'Opinion cluster ID — identifies a case decision and groups all opinion variants (majority, concurrence, dissent). Obtain from courtlistener_search_opinions, courtlistener_lookup_citation, or from docket results that link to opinions.',
      ),
  }),

  output: z.object({
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
    opinions: z
      .array(
        z
          .object({
            id: z.number().describe('Individual opinion ID.'),
            type: z
              .string()
              .describe(
                'Opinion type: "lead-opinion", "concurrence", "dissent", "combined-opinion", etc.',
              ),
            author_id: z
              .number()
              .nullable()
              .describe('Person ID of the author; null if per curiam or unknown.'),
            per_curiam: z.boolean().describe('True if this is a per curiam opinion.'),
            html_text: z
              .string()
              .describe(
                'Full opinion text as HTML; may be empty if only a download URL is available.',
              ),
            plain_text: z.string().describe('Plain text version of the opinion; may be empty.'),
            cites: z.array(z.number()).describe('Opinion IDs this opinion cites.'),
            download_url: z
              .string()
              .nullable()
              .describe(
                'Direct download URL for the original opinion document; null if not available.',
              ),
          })
          .describe('Individual opinion variant.'),
      )
      .describe('All opinion variants within this cluster.'),
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
      const match = cluster.docket.match(/\/dockets\/(\d+)\//);
      if (match?.[1]) docketId = parseInt(match[1], 10);
    }

    const opinions = (cluster.sub_opinions ?? []).map((op) => ({
      id: op.id,
      type: op.type ?? '',
      author_id: op.author_id ?? null,
      per_curiam: op.per_curiam ?? false,
      html_text: op.html ?? '',
      plain_text: op.plain_text ?? '',
      // opinions_cited are URI strings — extract the numeric ID from each
      cites: (op.opinions_cited ?? []).flatMap((uri) => {
        const match = String(uri).match(/\/opinions\/(\d+)\//);
        return match?.[1] ? [parseInt(match[1], 10)] : [];
      }),
      download_url: op.download_url ?? null,
    }));

    ctx.log.info('courtlistener_get_opinion complete', {
      cluster_id: input.cluster_id,
      opinions_count: opinions.length,
    });

    return {
      cluster_id: cluster.id,
      case_name: cluster.caseName ?? '',
      case_name_full: cluster.caseNameFull ?? '',
      court: cluster.court ?? '',
      court_id: cluster.court_id ?? '',
      date_filed: cluster.date_filed ?? '',
      docket_id: docketId,
      docket_number: cluster.docket_number ?? '',
      judges: cluster.judges ?? '',
      citations,
      cite_count: cluster.citation_count ?? 0,
      precedential_status: cluster.precedential_status ?? '',
      syllabus: cluster.syllabus ?? '',
      posture: cluster.posture ?? '',
      opinions,
    };
  },

  format: (result) => {
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

    for (const op of result.opinions) {
      lines.push(`\n### Opinion (${op.type})`);
      lines.push(`**ID:** ${op.id} | **Per Curiam:** ${op.per_curiam ? 'Yes' : 'No'}`);
      if (op.author_id != null) lines.push(`**Author ID:** ${op.author_id}`);
      if (op.cites.length > 0) lines.push(`**Cites:** ${op.cites.join(', ')}`);
      if (op.download_url) lines.push(`**Download:** ${op.download_url}`);

      // Render available opinion text — both plain_text and html_text are included
      // when present; plain_text is shown first as it is typically cleaner
      if (op.plain_text) {
        const excerpt = op.plain_text.slice(0, 2000);
        lines.push(
          `\n${excerpt}${op.plain_text.length > 2000 ? '\n\n*[plain_text truncated]*' : ''}`,
        );
      }
      if (op.html_text) {
        const excerpt = op.html_text.slice(0, 2000);
        lines.push(
          `\n**html_text:** ${excerpt}${op.html_text.length > 2000 ? '\n\n*[html_text truncated]*' : ''}`,
        );
      }
      if (!op.plain_text && !op.html_text && op.download_url) {
        lines.push(
          `\n*Opinion text not stored locally. Use download_url to retrieve the document.*`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
