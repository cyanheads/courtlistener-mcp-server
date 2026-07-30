/**
 * @fileoverview List CourtListener courts filtered by jurisdiction type and scraper status.
 * @module mcp-server/tools/definitions/lookup-courts.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { listSnapshotCourtIds } from '@/services/courtlistener/court-names.js';
import { COURT_SNAPSHOT_DATE } from '@/services/courtlistener/court-names-data.js';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

/**
 * Ceiling on the offline id list inlined in one response. The whole set is 3,359 courts —
 * roughly 48KB of ids, repeated again in the `content[]` render — which would crowd out the
 * court records the caller actually asked for. Sized at about twice the active bench (472,
 * the default filter) so every realistic filter still returns its complete list, and the
 * four that do not (`status:'any'` and `status:'inactive'`, alone or with `jurisdiction:'ST'`)
 * get a count and a narrowing hint instead of a silent prefix.
 */
const MAX_INLINE_COURT_IDS = 1000;

export const lookupCourtsTool = tool('courtlistener_lookup_courts', {
  title: 'Lookup Courts',
  description:
    "List courts with optional filtering by jurisdiction type, active/inactive status, and scraper coverage. Primarily used to discover court IDs for use in search and filter parameters across all other courtlistener tools. Defaults to the active bench — the courts CourtListener still scrapes; pass status:'inactive' for historical courts or status:'any' for every court. A bundled snapshot returns the complete list of matching court IDs without paging whenever the filtered set fits the response budget, which covers the default bench and every jurisdiction filter. Full court records — names, citation strings, scraper status — come live from CourtListener at a fixed 20 rows per page, so pull those only when a court ID alone is not enough.",
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
      .describe('Matching courts on this page.'),
    all_matching_court_ids: z
      .array(z.string())
      .describe(
        `Every court id matching the same filters, from a snapshot of /courts/ bundled with this server (taken ${COURT_SNAPSHOT_DATE}) — the complete set, not just this page, and free of any request. Paging \`courts\` is only needed for the fields a court id alone does not carry (full_name, citation_string, scraper flags). Empty when more than ${MAX_INLINE_COURT_IDS} courts match, since a prefix of the set would be indistinguishable from the whole of it — check all_matching_court_ids_complete before reading emptiness as "no courts match". A court added or retired upstream since the snapshot date appears in \`courts\` but may be missing here.`,
      ),
    all_matching_court_ids_complete: z
      .boolean()
      .describe(
        `True when all_matching_court_ids holds every matching court id. False when more than ${MAX_INLINE_COURT_IDS} courts match: the list is withheld whole rather than truncated, and the notice gives the count and how to narrow.`,
      ),
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

    // The live page is 20 rows against a set that can run to thousands. The bundled
    // snapshot answers "which courts match" for the same filters at no request cost,
    // which is the only way that question is answerable at all under the free tier.
    const snapshotFilters = {
      jurisdiction: input.jurisdiction,
      in_use: inUse,
      has_opinion_scraper: input.has_opinion_scraper,
    };
    const matching = listSnapshotCourtIds(snapshotFilters);
    const complete = matching.length <= MAX_INLINE_COURT_IDS;

    // Two conditions can hold at once — a page past the end of a set that is itself too
    // large to inline — and `notice` is last-wins, so they compose into one string.
    const notices: string[] = [];
    if (courts.length === 0) {
      const filters: string[] = [`status=${input.status}`];
      if (input.jurisdiction) filters.push(`jurisdiction=${input.jurisdiction}`);
      if (input.has_opinion_scraper) filters.push('has_opinion_scraper=true');
      const widen =
        input.status === 'any'
          ? 'Drop the remaining filters to widen the search.'
          : "Set status='any' to search the active and inactive benches together, or drop the remaining filters.";
      notices.push(`No courts matched filters: ${filters.join(', ')}. ${widen}`);
    }
    if (!complete) {
      // Naming the active-bench count turns the usual over-budget case (status='any')
      // into one concrete next call rather than a guess at which filter is small enough.
      const activeHint =
        inUse === undefined
          ? ` Narrowing to status='active' matches ${listSnapshotCourtIds({ ...snapshotFilters, in_use: true }).length}.`
          : '';
      notices.push(
        `${matching.length} courts match these filters, past the ${MAX_INLINE_COURT_IDS}-id ceiling for inlining the offline list, so all_matching_court_ids is empty rather than a prefix that would read as the whole set. Narrow with jurisdiction, status, or has_opinion_scraper to get the complete list in one call.${activeHint} The live \`courts\` page is unaffected.`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      page: input.page,
      next_cursor: data.next_cursor,
      courts,
      all_matching_court_ids: complete ? matching : [],
      all_matching_court_ids_complete: complete,
    };
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

    if (result.all_matching_court_ids_complete) {
      lines.push(
        `\n**All ${result.all_matching_court_ids.length} matching court IDs** (bundled snapshot, ${COURT_SNAPSHOT_DATE} — complete, no paging needed):`,
      );
      lines.push(result.all_matching_court_ids.map((id) => `\`${id}\``).join(', '));
    } else {
      lines.push(
        `\n**Matching court IDs withheld** — more than ${MAX_INLINE_COURT_IDS} courts match, so the bundled snapshot list is not complete enough to inline. Narrow the filters to get it.`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
