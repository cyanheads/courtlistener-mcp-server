/**
 * @fileoverview Full-text search across CourtListener's 9M+ court opinion corpus.
 * @module mcp-server/tools/definitions/search-opinions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

export const searchOpinionsTool = tool('courtlistener_search_opinions', {
  title: 'Search Court Opinions',
  description:
    'Full-text search across 9M+ written US court opinions with field-level filtering. Returns opinion cluster summaries with case metadata, citations, and matched text snippets. Supports CourtListener field syntax (caseName:"roe v wade", court_id:scotus, judge:"Alito") and boolean operators (AND, OR, NOT). Use courtlistener_lookup_courts to find court IDs. Rate limit: 5 req/min, 50/hr, 125/day on the free tier.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },

  input: z.object({
    q: z
      .string()
      .min(1)
      .describe(
        'Full-text query. Supports field syntax (caseName:"roe v wade", court_id:scotus, judge:"Alito") and boolean operators (AND, OR, NOT). Use plain English for semantic-style queries or legal citations.',
      ),
    court: z
      .string()
      .optional()
      .describe(
        'Filter to a specific court by court ID (e.g., "scotus", "ca9", "nyed"). Use courtlistener_lookup_courts to find court IDs.',
      ),
    filed_after: z
      .string()
      .optional()
      .describe(
        'Earliest filing date (ISO 8601, e.g., "2020-01-01"). Narrows search to opinions filed on or after this date.',
      ),
    filed_before: z
      .string()
      .optional()
      .describe(
        'Latest filing date (ISO 8601). Narrows search to opinions filed before or on this date.',
      ),
    status: z
      .enum([
        'Published',
        'Unpublished',
        'Errata',
        'Separate',
        'In-chambers',
        'Relating-to',
        'Unknown',
      ])
      .optional()
      .describe(
        'Opinion publication status. "Published": precedential. "Unpublished": not citable as precedent in most jurisdictions. "Errata": corrections. "Separate": separate opinion filed outside main cluster. "In-chambers": single-justice order. "Relating-to": companion or related-case order. Omit to search all statuses.',
      ),
    order_by: z
      .enum(['score desc', 'dateFiled desc', 'dateFiled asc', 'citeCount desc'])
      .optional()
      .default('score desc')
      .describe(
        'Result ordering. "score desc" (default) ranks by relevance. "citeCount desc" surfaces most-cited opinions first.',
      ),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(10)
      .describe(
        'Number of results (1–20, default 10). Keep low — each search costs one request against the rate limit.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Pagination cursor from a previous response's next_cursor field. Omit for the first page.",
      ),
  }),

  output: z.object({
    total_count: z.number().describe('Total matching opinions in the corpus.'),
    results: z
      .array(
        z
          .object({
            cluster_id: z
              .number()
              .describe(
                'Opinion cluster ID — pass to courtlistener_get_opinion or courtlistener_get_citations.',
              ),
            case_name: z.string().describe('Short case name (e.g., "Roe v. Wade").'),
            case_name_full: z.string().describe('Full case name with parties.'),
            court: z.string().describe('Court display name.'),
            court_id: z
              .string()
              .describe('Court identifier for use in subsequent filter parameters.'),
            date_filed: z.string().describe('Date the opinion was filed (YYYY-MM-DD).'),
            docket_number: z.string().describe('Docket number for this case.'),
            docket_id: z.number().describe('Docket ID — pass to courtlistener_get_docket.'),
            citations: z
              .array(z.string())
              .describe('Formatted citation strings (e.g., "410 U.S. 113").'),
            cite_count: z
              .number()
              .describe('Number of times this opinion has been cited by other opinions.'),
            judges: z.string().describe('Judge names associated with the opinion.'),
            status: z.string().describe('Publication status (Published, Unpublished, etc.).'),
            snippet: z.string().describe('Matched text excerpt from the opinion.'),
          })
          .describe('Opinion cluster summary.'),
      )
      .describe('Matching opinion cluster summaries.'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Pagination cursor for the next page; null when no more results.'),
  }),

  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: '429 response from CourtListener — minute, hour, or day throttle hit.',
      retryable: true,
      recovery:
        'Wait for the rate-limit window to reset (Retry-After header in seconds). Free tier: 5 req/min, 50/hr, 125/day.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Query uses invalid field syntax or unsupported operators.',
      recovery: 'Simplify the query, remove field-syntax prefixes, and retry with plain text.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_search_opinions', { q: input.q, court: input.court });
    const svc = getCourtListenerService();

    const data = await svc.searchOpinions(
      {
        q: input.q,
        court: input.court,
        filed_after: input.filed_after,
        filed_before: input.filed_before,
        status: input.status,
        order_by: input.order_by,
        page_size: input.page_size,
        cursor: input.cursor,
      },
      ctx,
    );

    const results = data.results.map((r) => ({
      cluster_id: r.id,
      case_name: r.caseName ?? '',
      case_name_full: r.caseNameFull ?? '',
      court: r.court ?? '',
      court_id: r.court_id ?? '',
      date_filed: r.dateFiled ?? '',
      docket_number: r.docketNumber ?? '',
      docket_id: r.docket_id ?? 0,
      citations: r.citation ?? [],
      cite_count: r.citeCount ?? 0,
      judges: r.judge ?? '',
      status: r.status ?? '',
      snippet: r.snippet ?? '',
    }));

    ctx.log.info('courtlistener_search_opinions complete', {
      total: data.total,
      returned: results.length,
    });

    return {
      total_count: data.total,
      results,
      next_cursor: data.nextCursor,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## CourtListener Opinion Search`,
      `**Total matching:** ${result.total_count} | **Returned:** ${result.results.length}`,
    ];

    if (result.results.length === 0) {
      lines.push(
        '\n> No opinions matched the query. Try broadening filters or revising search terms.',
      );
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const r of result.results) {
      lines.push(`\n### ${r.case_name}`);
      if (r.case_name_full && r.case_name_full !== r.case_name) {
        lines.push(`*${r.case_name_full}*`);
      }
      lines.push(
        `**Cluster ID:** ${r.cluster_id} | **Court:** ${r.court} (${r.court_id}) | **Filed:** ${r.date_filed}`,
      );
      lines.push(
        `**Docket:** ${r.docket_number} (ID: ${r.docket_id}) | **Status:** ${r.status} | **Citations:** ${r.cite_count}`,
      );
      if (r.citations.length > 0) {
        lines.push(`**Citation strings:** ${r.citations.join(', ')}`);
      }
      if (r.judges) lines.push(`**Judges:** ${r.judges}`);
      if (r.snippet) lines.push(`*${r.snippet}*`);
    }

    if (result.next_cursor) {
      lines.push(`\n**Next page cursor:** \`${result.next_cursor}\``);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
