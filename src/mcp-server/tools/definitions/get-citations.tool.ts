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
    'Retrieve the citation network for an opinion cluster. Supports two directions: "cited_by" (opinions that cite this one — measures precedential influence) and "citing" (opinions this one cites — reveals the authority chain relied on). This is the primary tool for tracing legal precedent chains. Note: the free tier (125 req/day) supports shallow traversal — following 1–2 hops of a single case is practical; deep multi-hop analysis burns through the daily budget quickly.',
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
        'Number of results to request (default 20). For direction="cited_by", CourtListener enforces a minimum of 20 results per page regardless of the value passed — you will always receive at least 20 results. direction="citing" returns at most page_size (the cited-opinion list is sliced before querying) — fewer when the opinion cites fewer than page_size distinct opinions. Each citation tool call costs one request against the rate limit — keep low for multi-hop traversal.',
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
              .describe('Text excerpt showing context around the citation (where available).'),
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
    totalCount: z.number().describe('Total citations in the requested direction.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no citations are found — echoes direction and filters, suggests alternatives.',
      ),
  },

  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: '429 response from CourtListener.',
      retryable: true,
      recovery:
        'Wait for the Retry-After period before retrying. Free tier: 5 req/min, 50/hr, 125/day.',
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

    // Guard before the service call: a malformed date would otherwise spend one of
    // the free tier's 125 daily requests on a 400 from the /search/ endpoint.
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

    // Resolve the source cluster's real case name. "citing" gets it free (getCiting
    // already fetched the cluster); "cited_by" needs a lightweight name-only fetch
    // (non-fatal — falls back to the cluster-id placeholder if it fails).
    let sourceCaseName = `(cluster ${input.cluster_id})`;
    if ('sourceCaseName' in data && typeof data.sourceCaseName === 'string') {
      // "citing" — getCiting already resolved the name.
      sourceCaseName = data.sourceCaseName;
    } else if (input.direction === 'cited_by') {
      // "cited_by" — getCitedBy never fetched the cluster; resolve the name cheaply (non-fatal).
      try {
        const name = await svc.getClusterCaseName(input.cluster_id, ctx);
        if (name) sourceCaseName = name;
      } catch (err) {
        ctx.log.debug('source case name resolution failed', {
          clusterId: input.cluster_id,
          err: String(err),
        });
      }
    }

    const results = data.results.map((r) => ({
      cluster_id: r.cluster_id,
      case_name: r.caseName ?? '',
      court: r.court ?? '',
      court_id: r.court_id ?? '',
      date_filed: r.dateFiled ?? '',
      citations: r.citation ?? [],
      cite_count: r.citeCount ?? 0,
      snippet: r.snippet ?? '',
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
      ctx.enrich.notice(
        `No opinions found ${dirLabel} cluster ${input.cluster_id}${filterHint}. Try the opposite direction, remove filters, or verify the cluster ID.`,
      );
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
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const r of result.results) {
      lines.push(`\n### ${r.case_name}`);
      lines.push(
        `**Cluster ID:** ${r.cluster_id} | **Court:** ${r.court} (${r.court_id}) | **Filed:** ${r.date_filed}`,
      );
      lines.push(`**Authority weight (cited by):** ${r.cite_count}`);
      if (r.citations.length > 0) lines.push(`**Citations:** ${r.citations.join(', ')}`);
      if (r.snippet) lines.push(`*${r.snippet}*`);
    }

    if (result.next_cursor) {
      lines.push(`\n**Next page cursor:** \`${result.next_cursor}\``);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
