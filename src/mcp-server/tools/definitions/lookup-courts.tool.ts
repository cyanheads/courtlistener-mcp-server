/**
 * @fileoverview List CourtListener courts filtered by jurisdiction type and scraper status.
 * @module mcp-server/tools/definitions/lookup-courts.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

export const lookupCourtsTool = tool('courtlistener_lookup_courts', {
  title: 'Lookup Courts',
  description:
    "List courts with optional filtering by jurisdiction type, active/inactive status, and scraper coverage. Primarily used to discover court IDs for use in search and filter parameters across all other courtlistener tools. Defaults to the active bench — the courts CourtListener still scrapes; pass status:'inactive' for historical courts or status:'any' for every court. Returns one page of court IDs, full names, citation strings, and scraper status: the endpoint serves a fixed 20 rows per page, so listing a whole bench costs one call per 20 courts against a rate-limited free tier — filter by jurisdiction to answer a question in one call rather than paging.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },

  input: z.object({
    jurisdiction: z
      .enum([
        'F',
        'FD',
        'FB',
        'FBP',
        'FS',
        'C',
        'I',
        'T',
        'ST',
        'SS',
        'SAG',
        'SAL',
        'SA',
        'S',
        'TT',
      ])
      .optional()
      .describe(
        'Jurisdiction type. F=Federal Appellate (circuit courts, SCOTUS), FD=Federal District, FB=Federal Bankruptcy, FBP=Federal Bankruptcy Panel, FS=Federal Special (USITC, FISC, etc.), C=Circuit (historical), I=International, T=Territory, ST=State Trial, SS=State Supreme, SAG=State Attorney General, SAL=State Legislature, SA=State Appellate, S=State (other), TT=Tribal/Territory. Omit to list all.',
      ),
    status: z
      .enum(['active', 'inactive', 'any'])
      .optional()
      .default('active')
      .describe(
        "Which bench to return. 'active' (default) returns only courts CourtListener currently scrapes; 'inactive' returns only the historical and defunct courts it no longer scrapes; 'any' returns both. The two filtered sets are disjoint, so 'any' is the only value that reaches the whole list — but reaching all of it means paging, one call per 20 courts, and the inactive bench is several times larger than the active one. Prefer the narrowest value that answers the question, and narrow with jurisdiction rather than paging the full list.",
      ),
    has_opinion_scraper: z
      .boolean()
      .optional()
      .describe(
        'Filter to courts with active opinion scraping. Useful when planning search queries — courts without scrapers have sparse coverage.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .default(1)
      .describe(
        'Page number (1-indexed). CourtListener serves /courts/ at a fixed 20 rows per page and ignores any requested page size, so the number of pages is the enrichment totalCount divided by 20 — there is no way to pull a larger page. Pass the next_cursor from a previous response here to walk them one call at a time.',
      ),
  }),

  output: z.object({
    page: z.number().describe('Current page number (1-indexed).'),
    next_cursor: z
      .string()
      .nullable()
      .describe(
        'Next page number to pass as the `page` argument (this list is page-paginated at a fixed 20 rows/page); null when this is the last page — a non-null value means the courts shown are a partial view of the filtered set.',
      ),
    courts: z
      .array(
        z
          .object({
            id: z.string().describe('Court identifier for use in search filter parameters.'),
            full_name: z.string().describe('Full court name.'),
            short_name: z.string().describe('Abbreviated court name.'),
            citation_string: z
              .string()
              .describe('Citation abbreviation (e.g., "9th Cir.", "SCOTUS").'),
            jurisdiction: z.string().describe('Jurisdiction type code.'),
            has_opinion_scraper: z
              .boolean()
              .describe('True if CourtListener actively scrapes opinions from this court.'),
            has_oral_argument_scraper: z
              .boolean()
              .describe('True if CourtListener actively scrapes oral arguments from this court.'),
          })
          .describe('Court record.'),
      )
      .describe('Matching courts.'),
  }),

  // Agent-facing context: total count and recovery hint on empty results.
  enrichment: {
    totalCount: z.number().describe('Total courts returned.'),
    notice: z
      .string()
      .optional()
      .describe('Recovery hint when no courts match the applied filters.'),
  },

  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: '429 response from CourtListener.',
      retryable: false,
      recovery:
        'Wait out the Retry-After interval reported on the error before calling again. CourtListener throttles per minute, hour, and day, so an immediate retry fails.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_lookup_courts', {
      jurisdiction: input.jurisdiction,
      status: input.status,
    });
    const svc = getCourtListenerService();

    // Upstream's `in_use` is a plain boolean exact-match filter, so 'active' and
    // 'inactive' select disjoint halves and only omitting it returns every court.
    const inUse = input.status === 'any' ? undefined : input.status === 'active';

    const data = await svc.listCourts(
      {
        jurisdiction: input.jurisdiction,
        in_use: inUse,
        has_opinion_scraper: input.has_opinion_scraper,
        page: input.page,
      },
      ctx,
    );

    const courts = data.courts.map((c) => ({
      id: c.id,
      full_name: c.full_name ?? '',
      short_name: c.short_name ?? '',
      citation_string: c.citation_string ?? '',
      jurisdiction: c.jurisdiction ?? '',
      has_opinion_scraper: c.has_opinion_scraper ?? false,
      has_oral_argument_scraper: c.has_oral_argument_scraper ?? false,
    }));

    ctx.log.info('courtlistener_lookup_courts complete', { count: courts.length });

    ctx.enrich.total(data.total);
    if (courts.length === 0) {
      const filters: string[] = [`status=${input.status}`];
      if (input.jurisdiction) filters.push(`jurisdiction=${input.jurisdiction}`);
      if (input.has_opinion_scraper) filters.push('has_opinion_scraper=true');
      const widen =
        input.status === 'any'
          ? 'Drop the remaining filters to widen the search.'
          : "Set status='any' to search the active and inactive benches together, or drop the remaining filters.";
      ctx.enrich.notice(`No courts matched filters: ${filters.join(', ')}. ${widen}`);
    }

    return { page: input.page, next_cursor: data.next_cursor, courts };
  },

  format: (result) => {
    const lines: string[] = [
      `## CourtListener Courts`,
      `**Page:** ${result.page} | **Next cursor:** ${result.next_cursor ?? 'none'}`,
    ];

    if (result.courts.length === 0) {
      lines.push('\n> No courts matched the filters.');
    } else {
      lines.push(
        '\n| ID | Full Name | Short Name | Citation | Jurisdiction | Opinion Scraper | OA Scraper |',
      );
      lines.push(
        '|:---|:---------|:----------|:---------|:-------------|:---------------|:----------|',
      );
      for (const c of result.courts) {
        lines.push(
          `| \`${c.id}\` | ${c.full_name} | ${c.short_name} | ${c.citation_string} | ${c.jurisdiction} | ${c.has_opinion_scraper ? 'Yes' : 'No'} | ${c.has_oral_argument_scraper ? 'Yes' : 'No'} |`,
        );
      }
    }

    if (result.next_cursor) {
      lines.push(`\n*More courts available — pass page=${result.next_cursor} to continue.*`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
