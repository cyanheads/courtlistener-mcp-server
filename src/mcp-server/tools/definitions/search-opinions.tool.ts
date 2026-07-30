/**
 * @fileoverview Full-text search across CourtListener's 9M+ court opinion corpus.
 * @module mcp-server/tools/definitions/search-opinions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import { findInvalidDates, ISO_DATE_HINT } from '@/services/courtlistener/dates.js';
import { toStorageUrl } from '@/services/courtlistener/uri.js';

export const searchOpinionsTool = tool('courtlistener_search_opinions', {
  title: 'Search Court Opinions',
  description:
    'Full-text search across 9M+ written US court opinions with field-level filtering. Returns opinion cluster summaries with case metadata, citations, matched text snippets, and the individual opinion variants filed in each case. Supports CourtListener field syntax (caseName:"roe v wade", court_id:scotus, judge:"Alito") and boolean operators (AND, OR, NOT). Use courtlistener_lookup_courts to find court IDs. Rate limit: 5 req/min, 50/hr, 125/day on the free tier.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },

  input: z.object({
    q: z
      .string()
      .trim()
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
      .default(20)
      .describe(
        'Number of results to request (default 20). CourtListener search enforces a minimum of 20 results per page regardless of the value passed — you will always receive at least 20 results. Each search costs one request against the rate limit.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Pagination cursor from a previous response's next_cursor field. Omit for the first page.",
      ),
  }),

  output: z.object({
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
            snippet: z
              .string()
              .describe(
                'Matched text excerpt, taken from the first entry in opinions[] that carries one; empty string when no variant has an excerpt. CourtListener does not mark which variant the search matched, so treat this as a relevance preview for the cluster, not as an excerpt attributable to a specific opinion — read opinions[] to attribute it.',
              ),
            opinions: z
              .array(
                z
                  .object({
                    id: z
                      .number()
                      .describe(
                        'Opinion ID for this variant — identifies one opinion within the cluster (the cluster itself is cluster_id).',
                      ),
                    type: z
                      .string()
                      .describe(
                        'Variant type as an expanded label (e.g. "combined-opinion", "lead-opinion", "dissent").',
                      ),
                    author_id: z
                      .number()
                      .nullable()
                      .describe(
                        'Person ID of the authoring judge — pass to courtlistener_get_judge; null when unattributed.',
                      ),
                    per_curiam: z
                      .boolean()
                      .describe('True when the opinion was issued per curiam (by the court).'),
                    download_url: z
                      .string()
                      .nullable()
                      .describe(
                        "URL of the originating court's copy; null when none was recorded. Often plain HTTP and prone to rot — prefer local_path.",
                      ),
                    local_path: z
                      .string()
                      .nullable()
                      .describe(
                        'CourtListener-hosted copy of the source document (https://storage.courtlistener.com/...); null if not stored.',
                      ),
                    cites: z
                      .array(z.number())
                      .describe(
                        'Opinion IDs this variant cites. These are opinion-level IDs, not cluster IDs — courtlistener_get_opinion and courtlistener_get_citations both take a cluster_id, so do not pass these values to them directly.',
                      ),
                  })
                  .describe('One opinion variant within the cluster.'),
              )
              .describe(
                'Opinion variants filed in this case (majority, concurrence, dissent, per curiam). Empty when upstream returned none.',
              ),
          })
          .describe('Opinion cluster summary.'),
      )
      .describe('Matching opinion cluster summaries.'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Pagination cursor for the next page; null when no more results.'),
  }),

  // Agent-facing context: total match count, echoed query/filters, and recovery hint
  // on empty pages — on both structuredContent and content[] without a format() entry.
  enrichment: {
    totalCount: z.number().describe('Total matching opinions in the corpus.'),
    effectiveQuery: z.string().describe('Query terms sent to CourtListener.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty — echoes filters and suggests how to broaden.',
      ),
  },

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
      code: JsonRpcErrorCode.ValidationError,
      when: 'Query uses invalid field syntax or unsupported operators.',
      recovery: 'Simplify the query, remove field-syntax prefixes, and retry with plain text.',
    },
    {
      reason: 'empty_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'q is empty or whitespace-only after trimming — no request is sent.',
      recovery:
        'Supply search terms in q — a case name, legal concept, or CourtListener field expression.',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'filed_after or filed_before is not a valid ISO 8601 calendar date.',
      recovery: 'Pass each date filter as a real YYYY-MM-DD calendar date, for example 2020-01-01.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_search_opinions', { q: input.q, court: input.court });

    // Guard before the service call: both rejections would otherwise spend one of
    // the free tier's 125 daily requests on input that cannot return useful data.
    if (!input.q) {
      throw ctx.fail(
        'empty_query',
        'The q parameter is empty or whitespace-only. Supply search terms — e.g. q: "qualified immunity" or q: caseName:"roe v wade".',
      );
    }

    const invalidDates = findInvalidDates({
      filed_after: input.filed_after,
      filed_before: input.filed_before,
    });
    if (invalidDates.length > 0) {
      throw ctx.fail(
        'invalid_date',
        `Invalid date filter: ${invalidDates.join(', ')}. ${ISO_DATE_HINT}`,
      );
    }

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

    const results = data.results.map((r) => {
      const variants = r.opinions ?? [];
      return {
        cluster_id: r.cluster_id,
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
        // v4 carries the matched excerpt per opinion variant, never on the cluster row.
        // Nothing marks which variant matched, so take the first that has one.
        snippet: variants.find((o) => o.snippet)?.snippet ?? '',
        opinions: variants.map((o) => ({
          id: o.id,
          type: o.type ?? '',
          author_id: o.author_id ?? null,
          per_curiam: o.per_curiam ?? false,
          download_url: o.download_url ?? null,
          local_path: toStorageUrl(o.local_path ?? null),
          cites: o.cites ?? [],
        })),
      };
    });

    ctx.log.info('courtlistener_search_opinions complete', {
      total: data.total,
      returned: results.length,
    });

    ctx.enrich.total(data.total);
    ctx.enrich.echo(input.q);
    if (results.length === 0) {
      const filters: string[] = [];
      if (input.court) filters.push(`court="${input.court}"`);
      if (input.filed_after) filters.push(`filed_after=${input.filed_after}`);
      if (input.filed_before) filters.push(`filed_before=${input.filed_before}`);
      if (input.status) filters.push(`status=${input.status}`);
      const filterHint = filters.length > 0 ? ` with filters: ${filters.join(', ')}` : '';
      ctx.enrich.notice(
        `No opinions matched "${input.q}"${filterHint}. Try broadening filters, checking field syntax, or revising search terms.`,
      );
    }

    return { results, next_cursor: data.nextCursor };
  },

  format: (result) => {
    const lines: string[] = [
      `## CourtListener Opinion Search`,
      `**Returned:** ${result.results.length}`,
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

      if (r.opinions.length > 0) {
        lines.push('**Opinions in this cluster:**');
        for (const o of r.opinions) {
          const curiam = o.per_curiam ? ' (per_curiam)' : '';
          const author = o.author_id != null ? ` | author_id ${o.author_id}` : '';
          lines.push(`  - Opinion ID ${o.id} — ${o.type}${curiam}${author}`);
          if (o.local_path) lines.push(`    CourtListener copy: ${o.local_path}`);
          if (o.download_url) lines.push(`    Court copy (download_url): ${o.download_url}`);
          if (o.cites.length > 0) {
            lines.push(`    Cites ${o.cites.length} opinions: ${o.cites.join(', ')}`);
          }
        }
      }
    }

    if (result.next_cursor) {
      lines.push(`\n**Next page cursor:** \`${result.next_cursor}\``);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
