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
    'List courts with optional filtering by jurisdiction type and scraper status. Primarily used to discover court IDs for use in search and filter parameters across all other courtlistener tools. Returns court IDs, full names, citation strings, and scraper status.',
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
    in_use: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'When true (default), only return courts currently scraped by CourtListener. Set to false to include historical or inactive courts.',
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
        'Page number (1-indexed). CourtListener caps /courts/ at ~20 rows per page regardless of size, so the full list (~472 courts) spans ~24 pages — pass the next_cursor from a previous response here to page through them.',
      ),
  }),

  output: z.object({
    page: z.number().describe('Current page number (1-indexed).'),
    next_cursor: z
      .string()
      .nullable()
      .describe(
        'Next page number to pass as the `page` argument (this list is page-paginated at ~20 rows/page); null when this is the last page.',
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
      in_use: input.in_use,
    });
    const svc = getCourtListenerService();

    const data = await svc.listCourts(
      {
        jurisdiction: input.jurisdiction,
        in_use: input.in_use,
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
      const filters: string[] = [];
      if (input.jurisdiction) filters.push(`jurisdiction=${input.jurisdiction}`);
      if (input.has_opinion_scraper) filters.push('has_opinion_scraper=true');
      const filterHint = filters.length > 0 ? ` with filters: ${filters.join(', ')}` : '';
      ctx.enrich.notice(
        `No courts matched${filterHint}. Try removing filters or setting in_use=false to include inactive courts.`,
      );
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
