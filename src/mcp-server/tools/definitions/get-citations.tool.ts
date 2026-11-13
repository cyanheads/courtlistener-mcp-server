/**
 * @fileoverview Retrieve the citation network for a CourtListener opinion cluster.
 * @module mcp-server/tools/definitions/get-citations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { citingOffset } from '@/services/courtlistener/citing-offset.js';
import { courtFilterGuidance } from '@/services/courtlistener/court-names.js';
import {
  getCourtListenerService,
  OPINION_ORDERS,
  OPINION_STATUSES,
} from '@/services/courtlistener/courtlistener-service.js';
import { findInvalidDates, ISO_DATE_HINT } from '@/services/courtlistener/dates.js';
import {
  Completion,
  formatPageSizing,
  PageSizing,
  pageSizing,
} from '@/services/courtlistener/page-metadata.js';
import { escapeText, readableText } from '@/services/courtlistener/readable-text.js';

export const getCitationsTool = tool('courtlistener_get_citations', {
  title: 'Get Citation Network',
  description:
    'Retrieve the citation network for an opinion cluster. "cited_by" lists opinions that cite this cluster; "citing" lists opinions it cites. Result rows default to Published in both directions; select statuses to expand or narrow the search. The free tier supports shallow traversal and deep multi-hop analysis can exhaust the request budget.',
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
        'Filter by one court ID or a space-separated list (e.g., "scotus ca9"). Applies to both directions. Find IDs with courtlistener_lookup_courts.',
      ),
    filed_after: z
      .string()
      .optional()
      .describe(
        'Limit to citations filed after this date (ISO 8601). For "cited_by", useful for "how has this precedent been applied recently?"',
      ),
    filed_before: z.string().optional().describe('Latest filing date (YYYY-MM-DD), inclusive.'),
    statuses: z
      .array(z.enum(OPINION_STATUSES))
      .min(1)
      .optional()
      .describe('Publication statuses to include in either direction. Omit for Published only.'),
    order_by: z
      .enum(OPINION_ORDERS)
      .optional()
      .describe(
        'Sort cited_by results upstream. Omit for relevance. Use citeCount desc for most cited.',
      ),
    page_size: z
      .number()
      .int()
      .min(1)
      .optional()
      .default(20)
      .describe(
        'Positive requested size (default 20), bounded to 20. cited_by has an upstream minimum of 20; citing slices at most 20 cited IDs by the bounded size before filtering. Full upstream pages are preserved. Final or filtered pages can be smaller or empty; retain next_cursor to continue. page_sizing distinguishes requested, bounded and actual sizes. A normal call costs three requests plus extra variant pages.',
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        'Pagination cursor from next_cursor. For citing, a nonnegative safe decimal integer offset; for cited_by, an opaque upstream token.',
      ),
  }),

  output: z.object({
    page_sizing: PageSizing.optional(),
    source_variants_completion: Completion.optional(),
    observed_total: z
      .number()
      .optional()
      .describe(
        'Citation total observed from the fetched source variants; a lower bound when total_is_partial is true.',
      ),
    total_is_partial: z
      .boolean()
      .optional()
      .describe(
        'True when citation results and totals are based on an incomplete source-variant set.',
      ),
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
                'Opening excerpt from the first opinion variant that supplies one; empty string when none does.',
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
      .optional()
      .describe(
        'Exact total when source variants are complete. For cited_by this counts clusters matching the filters, with Published as the default status. For citing it counts distinct cited opinions before any filter, which can exceed the cluster rows. Absent when total_is_partial is true.',
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
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A citing cursor is not a nonnegative safe decimal integer offset.',
      recovery: 'Pass the next_cursor from a citing response, or omit cursor to start over.',
      thrownBy: 'service',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Cluster ID does not exist in CourtListener. Both directions resolve the source cluster before searching, so a bad ID fails here rather than returning an empty network.',
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
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'filed_after or filed_before is not a valid ISO 8601 calendar date.',
      recovery: 'Pass each date filter as a real YYYY-MM-DD calendar date, for example 2020-01-01.',
    },
    {
      reason: 'unsupported_citation_order',
      code: JsonRpcErrorCode.ValidationError,
      when: 'order_by was supplied with the citing direction.',
      recovery: 'Omit order_by for citing or use the cited_by direction.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_get_citations', {
      cluster_id: input.cluster_id,
      direction: input.direction,
    });

    // Guard before the service call: a malformed date would otherwise spend three of the
    // free tier's daily requests to reach a 400 from the /search/ endpoint.
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

    if (input.direction === 'citing') {
      if (input.order_by !== undefined) {
        throw ctx.fail('unsupported_citation_order', 'order_by applies only to cited_by.');
      }
      citingOffset(input.cursor);
    }

    const svc = getCourtListenerService();

    const citationParams = {
      clusterId: input.cluster_id,
      court: input.court,
      filed_after: input.filed_after,
      ...(input.filed_before !== undefined && { filed_before: input.filed_before }),
      ...(input.statuses !== undefined && { statuses: input.statuses }),
      page_size: Math.min(input.page_size, 20),
      cursor: input.cursor,
    };

    const data =
      input.direction === 'cited_by'
        ? await svc.getCitedBy(
            {
              ...citationParams,
              ...(input.order_by !== undefined && { order_by: input.order_by }),
            },
            ctx,
          )
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
      // Generated citation searches leave highlighting off and keep the opening excerpt.
      snippet: readableText((r.opinions ?? []).find((o) => o.snippet)?.snippet ?? ''),
    }));

    ctx.log.info('courtlistener_get_citations complete', {
      direction: input.direction,
      total: data.total,
      returned: results.length,
    });

    const incomplete = data.sourceCompletion?.complete === false;
    if (!incomplete) ctx.enrich.total(data.total);
    if (incomplete)
      ctx.enrich.notice(
        `Citation results are partial because source variants remain unfetched; source cluster ${input.cluster_id}, upstream variant cursor ${data.sourceCompletion?.next_cursor}. A zero result does not establish absence. This cursor describes source completeness and is not a citation-page cursor.`,
      );
    if (results.length === 0 && !incomplete) {
      const dirLabel = input.direction === 'cited_by' ? 'citing' : 'cited by';
      const filters: string[] = [];
      if (input.court) filters.push(`court="${input.court}"`);
      if (input.filed_after) filters.push(`filed_after=${input.filed_after}`);
      if (input.filed_before) filters.push(`filed_before=${input.filed_before}`);
      if (input.statuses) filters.push(`statuses=${input.statuses.join(', ')}`);
      const filterHint = filters.length > 0 ? ` with filters: ${filters.join(', ')}` : '';
      const courtGuidance = courtFilterGuidance(input.court);
      if (input.direction === 'citing' && data.nextCursor !== null) {
        // "citing" pages the cited-opinion list, then filters each page upstream, so a
        // narrow filter can zero a page while later pages still hold matches — say which
        // it is rather than letting an exhausted-looking response stand.
        ctx.enrich.notice(
          `No opinions cited by cluster ${input.cluster_id} matched on this page${filterHint}, but more pages remain. The cited-opinion list is sliced before search. Pass cursor=${data.nextCursor} to check the next page.${courtGuidance}`,
        );
      } else {
        ctx.enrich.notice(
          `No opinions found ${dirLabel} cluster ${input.cluster_id}${filterHint}. Try the opposite direction, remove filters, or verify the cluster ID.${courtGuidance}`,
        );
      }
    }

    return {
      source_cluster_id: input.cluster_id,
      source_case_name: sourceCaseName,
      direction: input.direction,
      results,
      next_cursor: data.nextCursor,
      source_variants_completion: data.sourceCompletion,
      total_is_partial: incomplete,
      observed_total: data.total,
      page_sizing: pageSizing(
        input.page_size,
        20,
        results.length,
        input.direction === 'citing' ? 'cited_id_slice' : 'minimum_20',
      ),
    };
  },

  format: (result) => {
    const dirLabel = result.direction === 'cited_by' ? 'Cited By' : 'Citing';
    const lines: string[] = [
      `## Citation Network — ${dirLabel}`,
      formatPageSizing(result.page_sizing),
      ...(result.observed_total !== undefined
        ? [
            `**Observed citation total:** ${result.observed_total}${result.total_is_partial ? ' (partial lower bound)' : ''}`,
          ]
        : []),
      ...(result.source_variants_completion
        ? [
            `**Source variants:** complete=${result.source_variants_completion.complete}; upstream variant cursor=${result.source_variants_completion.next_cursor ?? 'none'}; citation total/results partial=${result.total_is_partial}.`,
          ]
        : []),
      `**Source Cluster:** ${result.source_cluster_id} ${result.source_case_name}`,
      `**Direction:** ${result.direction} | **Returned:** ${result.results.length}`,
    ];

    if (result.results.length === 0) {
      lines.push(
        result.total_is_partial
          ? '\n> No matches among the fetched source variants; unfetched variants may add citations.'
          : '\n> No citations found in this direction for the given filters.',
      );
    } else {
      for (const r of result.results) {
        lines.push(`\n### ${r.case_name}`);
        lines.push(
          `**Cluster ID:** ${r.cluster_id} | **Court:** ${r.court} (${r.court_id}) | **Filed:** ${r.date_filed}`,
        );
        lines.push(`**Authority weight (cited by):** ${r.cite_count}`);
        if (r.citations.length > 0) lines.push(`**Citations:** ${r.citations.join(', ')}`);
        if (r.snippet) lines.push(`*${escapeText(r.snippet)}*`);
      }
    }

    // Render outside the results branch so an empty page still surfaces the continuation cursor.
    if (result.next_cursor) {
      lines.push(`\n**Next page cursor:** \`${result.next_cursor}\``);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
