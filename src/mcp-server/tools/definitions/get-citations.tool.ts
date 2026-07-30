/**
 * @fileoverview Retrieve the citation network for a CourtListener opinion cluster.
 * @module mcp-server/tools/definitions/get-citations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import { findInvalidDates, ISO_DATE_HINT } from '@/services/courtlistener/dates.js';

export const getCitationsTool = tool('courtlistener_get_citations', {
  title: 'Get Citation Network',
  description:
    'Retrieve the citation network for an opinion cluster. Supports two directions: "cited_by" (opinions that cite this one — measures precedential influence) and "citing" (opinions this one cites — reveals the authority chain relied on). This is the primary tool for tracing legal precedent chains. Note: the free tier supports shallow traversal — following 1–2 hops of a single case is practical; deep multi-hop analysis burns through the daily budget quickly.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },

  input: z.object({
    cluster_id: z
      .number()
      .int()
      .describe(
        'Opinion cluster ID to retrieve citations for. Obtain from courtlistener_search_opinions or courtlistener_lookup_citation.',
      ),
    direction: z
      .enum(['citing', 'cited_by'])
      .default('cited_by')
      .describe(
        '"cited_by" (default): opinions that cite this one — measures precedential influence and downstream adoption. "citing": opinions this one cites — reveals the authority chain the court relied on.',
      ),
    court: z
      .string()
      .optional()
      .describe(
        'Filter results to a specific court (e.g., "scotus", "ca9"). Applies to both directions.',
      ),
    filed_after: z
      .string()
      .optional()
      .describe(
        'Limit to citations filed after this date (ISO 8601). For "cited_by", useful for "how has this precedent been applied recently?"',
      ),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(20)
      .describe(
        'Number of results to request (default 20). For direction="cited_by", CourtListener enforces a minimum of 20 results per page regardless of the value passed — you will always receive at least 20 results. direction="citing" returns at most page_size (the cited-opinion list is sliced before querying) — fewer when the opinion cites fewer than page_size distinct opinions. Either direction costs three requests against the rate limit (a case with many opinion variants costs one more per extra variant page) — keep low for multi-hop traversal.',
      ),
    cursor: z
      .string()
      .optional()
      .describe("Pagination cursor from a previous response's next_cursor field."),
  }),

  output: z.object({
    source_cluster_id: z.number().describe('The cluster ID this citation network is for.'),
    source_case_name: z.string().describe('Case name for the source cluster.'),
    direction: z
      .enum(['citing', 'cited_by'])
      .describe('Direction of the citation relationship returned.'),
    results: z
      .array(
        z
          .object({
            cluster_id: z.number().describe('Cluster ID of the related opinion.'),
            case_name: z.string().describe('Case name of the related opinion.'),
            court: z.string().describe('Court that issued the related opinion.'),
            court_id: z.string().describe('Court identifier for use in filter parameters.'),
            date_filed: z.string().describe('Date the related opinion was filed.'),
            citations: z.array(z.string()).describe('Citation strings for the related opinion.'),
            cite_count: z
              .number()
              .describe("This opinion's own citation count — its authority weight."),
            snippet: z
              .string()
              .describe(
                'Matched text excerpt from the related opinion, taken from the first opinion variant in the cluster that carries one; empty string when none does. It is a relevance preview for the cluster, not necessarily text surrounding the citation itself.',
              ),
          })
          .describe('Related opinion in the citation network.'),
      )
      .describe('Related opinions in the citation network.'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Pagination cursor for the next page; null when no more results.'),
  }),

  // Agent-facing context: total citation count and recovery hint on empty results.
  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Total citations in the requested direction. For "cited_by" it counts matching clusters with the court and filed_after filters applied. For "citing" it counts the distinct opinions this case cites, before any filter — so it exceeds what the filters make reachable, and runs higher than the result rows, which are clusters (several cited opinions in one case collapse to one row).',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Context when no citations are returned — either that this page had no match under the filters and more pages remain, or a recovery hint echoing direction and filters.',
      ),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Cluster ID does not exist in CourtListener. Both directions resolve the source cluster before searching, so a bad ID fails here rather than returning an empty network.',
      recovery:
        'Verify the cluster ID from courtlistener_search_opinions or courtlistener_lookup_citation.',
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
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'filed_after is not a valid ISO 8601 calendar date.',
      recovery: 'Pass filed_after as a real YYYY-MM-DD calendar date, for example 2020-01-01.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_get_citations', {
      cluster_id: input.cluster_id,
      direction: input.direction,
    });

    // Guard before the service call: a malformed date would otherwise spend three of the
    // free tier's daily requests to reach a 400 from the /search/ endpoint.
    const invalidDates = findInvalidDates({ filed_after: input.filed_after });
    if (invalidDates.length > 0) {
      throw ctx.fail(
        'invalid_date',
        `Invalid date filter: ${invalidDates.join(', ')}. ${ISO_DATE_HINT}`,
      );
    }

    const svc = getCourtListenerService();

    const citationParams = {
      clusterId: input.cluster_id,
      court: input.court,
      filed_after: input.filed_after,
      page_size: input.page_size,
      cursor: input.cursor,
    };

    const data =
      input.direction === 'cited_by'
        ? await svc.getCitedBy(citationParams, ctx)
        : await svc.getCiting(citationParams, ctx);

    // Both directions fetch the source cluster to resolve opinion IDs, so the case name
    // comes back with the results — no second lookup. Upstream leaves it empty on a few
    // sparse clusters; the ID stands in then.
    const sourceCaseName = data.sourceCaseName || `(cluster ${input.cluster_id})`;

    const results = data.results.map((r) => ({
      cluster_id: r.cluster_id,
      case_name: r.caseName ?? '',
      court: r.court ?? '',
      court_id: r.court_id ?? '',
      date_filed: r.dateFiled ?? '',
      citations: r.citation ?? [],
      cite_count: r.citeCount ?? 0,
      // v4 nests the matched excerpt under each opinion variant; nothing marks which
      // one matched, so take the first that carries one (same rule as search_opinions).
      snippet: (r.opinions ?? []).find((o) => o.snippet)?.snippet ?? '',
    }));

    ctx.log.info('courtlistener_get_citations complete', {
      direction: input.direction,
      total: data.total,
      returned: results.length,
    });

    ctx.enrich.total(data.total);
    if (results.length === 0) {
      const dirLabel = input.direction === 'cited_by' ? 'citing' : 'cited by';
      const filters: string[] = [];
      if (input.court) filters.push(`court="${input.court}"`);
      if (input.filed_after) filters.push(`filed_after=${input.filed_after}`);
      const filterHint = filters.length > 0 ? ` with filters: ${filters.join(', ')}` : '';
      if (input.direction === 'citing' && filters.length > 0 && data.nextCursor !== null) {
        // "citing" pages the cited-opinion list, then filters each page upstream, so a
        // narrow filter can zero a page while later pages still hold matches — say which
        // it is rather than letting an exhausted-looking response stand.
        ctx.enrich.notice(
          `No opinions cited by cluster ${input.cluster_id} matched ${filters.join(', ')} on this page, but more pages remain. The filters narrow each page after the cited-opinion list is sliced — pass cursor=${data.nextCursor} to check the next page.`,
        );
      } else {
        ctx.enrich.notice(
          `No opinions found ${dirLabel} cluster ${input.cluster_id}${filterHint}. Try the opposite direction, remove filters, or verify the cluster ID.`,
        );
      }
    }

    return {
      source_cluster_id: input.cluster_id,
      source_case_name: sourceCaseName,
      direction: input.direction,
      results,
      next_cursor: data.nextCursor,
    };
  },

  format: (result) => {
    const dirLabel = result.direction === 'cited_by' ? 'Cited By' : 'Citing';
    const lines: string[] = [
      `## Citation Network — ${dirLabel}`,
      `**Source Cluster:** ${result.source_cluster_id} ${result.source_case_name}`,
      `**Direction:** ${result.direction} | **Returned:** ${result.results.length}`,
    ];

    if (result.results.length === 0) {
      lines.push('\n> No citations found in this direction for the given filters.');
    } else {
      for (const r of result.results) {
        lines.push(`\n### ${r.case_name}`);
        lines.push(
          `**Cluster ID:** ${r.cluster_id} | **Court:** ${r.court} (${r.court_id}) | **Filed:** ${r.date_filed}`,
        );
        lines.push(`**Authority weight (cited by):** ${r.cite_count}`);
        if (r.citations.length > 0) lines.push(`**Citations:** ${r.citations.join(', ')}`);
        if (r.snippet) lines.push(`*${r.snippet}*`);
      }
    }

    // Render outside the results branch so an empty page still surfaces the continuation cursor.
    if (result.next_cursor) {
      lines.push(`\n**Next page cursor:** \`${result.next_cursor}\``);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
