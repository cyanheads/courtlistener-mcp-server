/**
 * @fileoverview Search federal judicial financial disclosure filings.
 * @module mcp-server/tools/definitions/search-financial-disclosures.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import { personIdFromUri } from '@/services/courtlistener/uri.js';

/** Disclosure report-type codes from CourtListener. */
const REPORT_TYPE_LABELS: Record<number, string> = {
  [-1]: 'Unknown',
  0: 'Nomination',
  1: 'Initial',
  2: 'Annual',
  3: 'Final',
};

export const searchFinancialDisclosuresTool = tool('courtlistener_search_financial_disclosures', {
  title: 'Search Financial Disclosures',
  description:
    "Search federal judicial financial disclosure filings — the annual reports judges file on investments, gifts, debts, outside positions, and income. Filter by judge (person ID from courtlistener_search_judges) and/or filing year. Returns per-filing metadata, category counts, itemized gifts, and a link to the source PDF. Line-item investments (often hundreds per filing, with coded values) are summarized as counts; the linked PDF carries the full itemization. Use this for judicial-ethics and recusal research after identifying a judge's person ID.",
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },

  input: z.object({
    judge_id: z
      .number()
      .int()
      .optional()
      .describe(
        'Person ID of the judge whose disclosures to return — obtain from courtlistener_search_judges (the person_id field). Omit to browse across all filers.',
      ),
    year: z
      .number()
      .int()
      .optional()
      .describe(
        'Filing year to filter by (e.g., 2022). Filters the fetched filings — pair with judge_id for complete per-judge results. Omit to return all available years.',
      ),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(20)
      .describe(
        'Number of filings to request (default 20). CourtListener enforces a minimum of 20 results per page regardless of the value passed — you will always receive at least 20 filings.',
      ),
    cursor: z
      .string()
      .optional()
      .describe("Pagination cursor from a previous response's next_cursor field."),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            disclosure_id: z.number().describe('Financial disclosure ID.'),
            person_id: z
              .number()
              .nullable()
              .describe(
                'Person ID of the filer — pass to courtlistener_get_judge; null if absent.',
              ),
            year: z.number().describe('Filing year.'),
            report_type: z
              .string()
              .describe('Report type (Nomination, Initial, Annual, Final, or Unknown).'),
            page_count: z
              .number()
              .nullable()
              .describe('Page count of the source filing; null if not recorded.'),
            has_been_extracted: z
              .boolean()
              .describe('True if line items were parsed from the PDF; counts are 0 when false.'),
            is_amended: z.boolean().describe('True if this filing is an amendment.'),
            pdf_url: z
              .string()
              .nullable()
              .describe('URL to the source disclosure PDF; null if unavailable.'),
            counts: z
              .object({
                investments: z.number().describe('Number of reported investments.'),
                gifts: z.number().describe('Number of reported gifts.'),
                debts: z.number().describe('Number of reported debts/liabilities.'),
                positions: z.number().describe('Number of reported outside positions.'),
                reimbursements: z.number().describe('Number of reported reimbursements.'),
                agreements: z.number().describe('Number of reported agreements.'),
                non_investment_incomes: z
                  .number()
                  .describe('Number of reported non-investment income sources.'),
                spouse_incomes: z.number().describe('Number of reported spouse income sources.'),
              })
              .describe('Count of line items in each disclosure category.'),
            gifts: z
              .array(
                z
                  .object({
                    description: z.string().describe('What the gift was.'),
                    source: z.string().describe('Who provided the gift.'),
                    value: z.string().describe('Reported dollar value; empty if not stated.'),
                  })
                  .describe('A reported gift.'),
              )
              .describe('Itemized gifts (the most ethics-relevant category; usually few).'),
          })
          .describe('A judicial financial disclosure filing.'),
      )
      .describe('Matching financial disclosure filings.'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Pagination cursor for the next page; null when no more results.'),
  }),

  // Agent-facing context: total filing count (when the API reports it) and a recovery hint on empty results.
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total matching disclosure filings — present only when the API reports a numeric count (this endpoint returns it as a URL by default, so it is usually absent).',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no filings are found — echoes filters and suggests next steps.',
      ),
  },

  errors: [
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: '429 response from CourtListener.',
      retryable: true,
      recovery: 'Wait for the Retry-After period. Free tier: 5 req/min, 50/hr, 125/day.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_search_financial_disclosures', {
      judge_id: input.judge_id,
      year: input.year,
    });
    const svc = getCourtListenerService();

    const data = await svc.searchFinancialDisclosures(
      {
        person: input.judge_id,
        page_size: input.page_size,
        cursor: input.cursor,
      },
      ctx,
    );

    // The endpoint has no server-side year filter (it 400s on unknown params), so filter here.
    const filtered =
      input.year !== undefined ? data.results.filter((d) => d.year === input.year) : data.results;

    const results = filtered.map((d) => ({
      disclosure_id: d.id,
      person_id: personIdFromUri(d.person ?? ''),
      year: d.year ?? 0,
      report_type: REPORT_TYPE_LABELS[d.report_type] ?? `Type ${d.report_type}`,
      page_count: d.page_count ?? null,
      has_been_extracted: d.has_been_extracted ?? false,
      is_amended: d.is_amended ?? false,
      pdf_url: d.filepath ?? null,
      counts: {
        investments: (d.investments ?? []).length,
        gifts: (d.gifts ?? []).length,
        debts: (d.debts ?? []).length,
        positions: (d.positions ?? []).length,
        reimbursements: (d.reimbursements ?? []).length,
        agreements: (d.agreements ?? []).length,
        non_investment_incomes: (d.non_investment_incomes ?? []).length,
        spouse_incomes: (d.spouse_incomes ?? []).length,
      },
      gifts: (d.gifts ?? []).map((g) => ({
        description: g.description ?? '',
        source: g.source ?? '',
        value: g.value ?? '',
      })),
    }));

    ctx.log.info('courtlistener_search_financial_disclosures complete', {
      total: data.total,
      returned: results.length,
    });

    // The list endpoint reports count as a URL unless ?count=on — only enrich when a real total is known.
    if (data.total !== null) ctx.enrich.total(data.total);
    if (results.length === 0) {
      const filters: string[] = [];
      if (input.judge_id !== undefined) filters.push(`judge_id=${input.judge_id}`);
      if (input.year !== undefined) filters.push(`year=${input.year}`);
      const filterHint = filters.length > 0 ? ` for filters: ${filters.join(', ')}` : '';
      ctx.enrich.notice(
        `No financial disclosures found${filterHint}. Verify the judge_id via courtlistener_search_judges, or widen the year filter — not all judges have disclosures on file.`,
      );
    }

    return { results, next_cursor: data.nextCursor };
  },

  format: (result) => {
    const lines: string[] = [`## Financial Disclosures`, `**Returned:** ${result.results.length}`];

    if (result.results.length === 0) {
      lines.push('\n> No financial disclosure filings matched the filters.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const d of result.results) {
      const c = d.counts;
      lines.push(`\n### ${d.report_type} disclosure — ${d.year}`);
      lines.push(
        `**Disclosure ID:** ${d.disclosure_id} | **Person ID:** ${d.person_id ?? 'Unknown'} | **Pages:** ${d.page_count ?? 'N/A'}`,
      );
      lines.push(
        `**Extracted:** ${d.has_been_extracted ? 'yes' : 'no'} | **Amended:** ${d.is_amended ? 'yes' : 'no'}`,
      );
      lines.push(
        `**Counts:** ${c.investments} investments, ${c.gifts} gifts, ${c.debts} debts, ${c.positions} positions, ${c.reimbursements} reimbursements, ${c.agreements} agreements, ${c.non_investment_incomes} non-investment incomes, ${c.spouse_incomes} spouse incomes`,
      );
      if (d.gifts.length > 0) {
        lines.push('**Gifts:**');
        for (const g of d.gifts) {
          const val = g.value ? ` — ${g.value}` : '';
          const src = g.source ? ` (from ${g.source})` : '';
          lines.push(`  - ${g.description}${src}${val}`);
        }
      }
      if (d.pdf_url) lines.push(`**Source PDF:** ${d.pdf_url}`);
    }

    if (result.next_cursor) {
      lines.push(`\n**Next page cursor:** \`${result.next_cursor}\``);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
