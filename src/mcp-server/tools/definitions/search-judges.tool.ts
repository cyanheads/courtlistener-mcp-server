/**
 * @fileoverview Search CourtListener judge/person records.
 * @module mcp-server/tools/definitions/search-judges.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

export const searchJudgesTool = tool('courtlistener_search_judges', {
  title: 'Search Judges',
  description:
    'Search judge/person records by name, appointing president, court, political affiliation, or demographic. Returns biographical data, current position, and appointment summary. Use courtlistener_get_judge for full appointment history and education records.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },

  input: z.object({
    q: z.string().min(1).describe('Search query — judge name, court, city, or relevant keywords.'),
    appointer: z
      .string()
      .optional()
      .describe(
        'Filter by appointing president\'s last name (e.g., "Obama", "Trump", "Biden"). Matches against the appointer field in position records.',
      ),
    court: z
      .string()
      .optional()
      .describe(
        'Filter to judges who have held a position at this court (e.g., "scotus", "ca9"). Use court_id strings from courtlistener_lookup_courts.',
      ),
    political_affiliation: z
      .enum(['d', 'r', 'i', 'l', 'g', 'u'])
      .optional()
      .describe(
        'Filter by political affiliation: d=Democrat, r=Republican, i=Independent, l=Libertarian, g=Green Party, u=Unknown/unconfirmed. Based on party of the appointing president or election affiliation.',
      ),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(20)
      .describe(
        'Number of results to request (default 20). CourtListener search enforces a minimum of 20 results per page regardless of the value passed.',
      ),
    cursor: z
      .string()
      .optional()
      .describe("Pagination cursor from a previous response's next_cursor field."),
  }),

  output: z.object({
    total_count: z.number().describe('Total matching judge records.'),
    results: z
      .array(
        z
          .object({
            person_id: z
              .number()
              .describe('Person ID — pass to courtlistener_get_judge for full biography.'),
            name: z.string().describe('Full judge name.'),
            gender: z.string().describe('Gender.'),
            dob: z.string().nullable().describe('Date of birth; null if not recorded.'),
            dob_city: z.string().nullable().describe('City of birth; null if not recorded.'),
            dob_state: z.string().nullable().describe('State of birth; null if not recorded.'),
            political_affiliation: z.array(z.string()).describe('Political affiliation codes.'),
            aba_rating: z.array(z.string()).describe('ABA qualification ratings.'),
            schools: z.array(z.string()).describe('Educational institutions attended.'),
            current_position: z
              .object({
                court: z
                  .string()
                  .nullable()
                  .describe('Court where currently serving; null if not applicable.'),
                court_id: z.string().nullable().describe('Court identifier.'),
                position_type: z
                  .string()
                  .nullable()
                  .describe('Position title (e.g., "District Judge").'),
                appointer: z
                  .string()
                  .nullable()
                  .describe('Appointing president; null if elected or not recorded.'),
                date_start: z.string().nullable().describe('Date position started.'),
              })
              .nullable()
              .describe('Current or most recent position; null if not available.'),
          })
          .describe('Judge search result.'),
      )
      .describe('Matching judge records.'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Pagination cursor for the next page; null when no more results.'),
  }),

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
    ctx.log.info('courtlistener_search_judges', { q: input.q });
    const svc = getCourtListenerService();

    const data = await svc.searchJudges(
      {
        q: input.q,
        appointer: input.appointer,
        court: input.court,
        political_affiliation: input.political_affiliation,
        page_size: input.page_size,
        cursor: input.cursor,
      },
      ctx,
    );

    const results = data.results.map((r) => ({
      person_id: r.id,
      name: r.name ?? '',
      gender: r.gender ?? '',
      dob: r.dob ?? null,
      dob_city: r.dob_city ?? null,
      dob_state: r.dob_state ?? null,
      political_affiliation: r.political_affiliation ?? [],
      aba_rating: r.aba_rating ?? [],
      schools: r.school ?? [],
      current_position:
        r.court || r.position_type
          ? {
              court: r.court ?? null,
              court_id: r.court_id ?? null,
              position_type: r.position_type ?? null,
              appointer: r.appointer ?? null,
              date_start: r.date_start ?? null,
            }
          : null,
    }));

    ctx.log.info('courtlistener_search_judges complete', {
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
      `## CourtListener Judge Search`,
      `**Total matching:** ${result.total_count} | **Returned:** ${result.results.length}`,
    ];

    if (result.results.length === 0) {
      lines.push(
        '\n> No judges matched the query. Try broadening filters or revising search terms.',
      );
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const r of result.results) {
      lines.push(`\n### ${r.name}`);
      lines.push(`**Person ID:** ${r.person_id} | **Gender:** ${r.gender}`);
      if (r.dob)
        lines.push(
          `**Born:** ${r.dob}${r.dob_city ? `, ${r.dob_city}` : ''}${r.dob_state ? `, ${r.dob_state}` : ''}`,
        );
      if (r.political_affiliation.length > 0) {
        lines.push(`**Political affiliation:** ${r.political_affiliation.join(', ')}`);
      }
      if (r.aba_rating.length > 0) lines.push(`**ABA rating:** ${r.aba_rating.join(', ')}`);
      if (r.schools.length > 0) lines.push(`**Schools:** ${r.schools.join(', ')}`);
      if (r.current_position) {
        const pos = r.current_position;
        lines.push(
          `**Current position:** ${pos.position_type ?? 'Unknown'}${pos.court ? ` at ${pos.court}` : ''}${pos.court_id ? ` (${pos.court_id})` : ''}${pos.appointer ? `, appointed by ${pos.appointer}` : ''}${pos.date_start ? ` (since ${pos.date_start})` : ''}`,
        );
      }
    }

    if (result.next_cursor) {
      lines.push(`\n**Next page cursor:** \`${result.next_cursor}\``);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
