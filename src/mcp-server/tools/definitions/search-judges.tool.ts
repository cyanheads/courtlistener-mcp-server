/**
 * @fileoverview Search CourtListener judge/person records.
 * @module mcp-server/tools/definitions/search-judges.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import type { PersonSearchPosition } from '@/services/courtlistener/types.js';

/**
 * Pick the position that best answers "what is this judge doing now?" from the
 * unordered `positions[]` array: prefer rows with no termination date, and break
 * ties (or an all-terminated history) by the latest start date.
 */
function selectCurrentPosition(positions: PersonSearchPosition[]): PersonSearchPosition | null {
  if (positions.length === 0) return null;
  const active = positions.filter((p) => !p.date_termination);
  const pool = active.length > 0 ? active : positions;
  return pool.reduce((latest, p) =>
    (p.date_start ?? '') > (latest.date_start ?? '') ? p : latest,
  );
}

export const searchJudgesTool = tool('courtlistener_search_judges', {
  title: 'Search Judges',
  description:
    'Search judge/person records by name, appointing president, court, political affiliation, or demographic. Returns biographical data, current position, and appointment summary. Use courtlistener_get_judge for full appointment history and education records.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },

  input: z.object({
    q: z.string().trim().describe('Search query — judge name, court, city, or relevant keywords.'),
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
            political_affiliation: z
              .array(z.string())
              .describe(
                'Party labels (e.g. "Democratic", "Republican"), one per recorded affiliation — not the single-letter codes the political_affiliation input filter takes.',
              ),
            aba_rating: z
              .array(z.string())
              .describe(
                'ABA qualification labels (e.g. "Well Qualified", "Qualified"), one per rating on record — not the rating codes.',
              ),
            schools: z.array(z.string()).describe('Educational institutions attended.'),
            current_position: z
              .object({
                court: z
                  .string()
                  .nullable()
                  .describe('Court full name; null for non-judicial positions.'),
                court_id: z
                  .string()
                  .nullable()
                  .describe(
                    'Court identifier for use in filter parameters; null for non-judicial positions.',
                  ),
                position_type: z
                  .string()
                  .nullable()
                  .describe(
                    'Judicial position title (e.g. "Judge", "Chief Judge"); null for non-judicial positions — see job_title.',
                  ),
                job_title: z
                  .string()
                  .nullable()
                  .describe(
                    'Free-text title for non-judicial roles (e.g. "Assistant district attorney"); null for judicial positions.',
                  ),
                organization_name: z
                  .string()
                  .nullable()
                  .describe('Employer for non-judicial roles; null for judicial positions.'),
                appointer: z
                  .string()
                  .nullable()
                  .describe(
                    'Name of the appointing president (e.g. "Obama, Barack Hussein, II"); null if elected or not recorded.',
                  ),
                selection_method: z
                  .string()
                  .nullable()
                  .describe(
                    'How the judge reached the position (e.g. "Appointment (President)", "Election (Partisan)"); null if not recorded.',
                  ),
                date_start: z
                  .string()
                  .nullable()
                  .describe('Date the position started; null if not recorded.'),
                date_termination: z
                  .string()
                  .nullable()
                  .describe('Date the position ended; null while the judge still holds it.'),
                termination_reason: z
                  .string()
                  .nullable()
                  .describe(
                    'Why the position ended (e.g. "Appointed to Other Judgeship", "Retirement"); null while still serving.',
                  ),
              })
              .nullable()
              .describe(
                'The position with no termination date, or — when several or none qualify — the one with the latest start date. Null when the record carries no positions. courtlistener_get_judge returns the full appointment history.',
              ),
          })
          .describe('Judge search result.'),
      )
      .describe('Matching judge records.'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Pagination cursor for the next page; null when no more results.'),
  }),

  // Agent-facing context: total match count and recovery hint on empty pages.
  enrichment: {
    totalCount: z.number().describe('Total matching judge records.'),
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
      when: '429 response from CourtListener.',
      retryable: false,
      recovery:
        'Wait out the Retry-After interval reported on the error before calling again. CourtListener throttles per minute, hour, and day, so an immediate retry fails.',
    },
    {
      reason: 'empty_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'q is empty or whitespace-only after trimming — no request is sent.',
      recovery: 'Supply search terms in q — a judge name, court, or city to match against.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_search_judges', { q: input.q });

    // Guard before the service call: a blank query would otherwise spend one of the
    // free tier's published 125 daily requests (actual limits vary by token tier) and
    // return unrelated records.
    if (!input.q) {
      throw ctx.fail(
        'empty_query',
        'The q parameter is empty or whitespace-only. Supply search terms — e.g. q: "Sotomayor".',
      );
    }

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

    const results = data.results.map((r) => {
      // Court and appointment data live only inside positions[]; the search result
      // carries no flat court/position_type fields to fall back on.
      const pos = selectCurrentPosition(r.positions ?? []);
      return {
        person_id: r.id,
        name: r.name ?? '',
        gender: r.gender ?? '',
        dob: r.dob ?? null,
        dob_city: r.dob_city ?? null,
        dob_state: r.dob_state ?? null,
        political_affiliation: r.political_affiliation ?? [],
        aba_rating: r.aba_rating ?? [],
        schools: r.school ?? [],
        // Upstream sends '' rather than null for unset text columns — collapse to null
        // so an absent value reads as absent instead of as an empty string.
        current_position: pos
          ? {
              court: pos.court_full_name || null,
              court_id: pos.court_exact || null,
              position_type: pos.position_type || null,
              job_title: pos.job_title || null,
              organization_name: pos.organization_name || null,
              appointer: pos.appointer || null,
              selection_method: pos.selection_method || null,
              date_start: pos.date_start || null,
              date_termination: pos.date_termination || null,
              termination_reason: pos.termination_reason || null,
            }
          : null,
      };
    });

    ctx.log.info('courtlistener_search_judges complete', {
      total: data.total,
      returned: results.length,
    });

    ctx.enrich.total(data.total);
    if (results.length === 0) {
      const filters: string[] = [];
      if (input.appointer) filters.push(`appointer="${input.appointer}"`);
      if (input.court) filters.push(`court="${input.court}"`);
      if (input.political_affiliation) filters.push(`affiliation=${input.political_affiliation}`);
      const filterHint = filters.length > 0 ? ` with filters: ${filters.join(', ')}` : '';
      ctx.enrich.notice(
        `No judges matched "${input.q}"${filterHint}. Try broadening filters or revising search terms.`,
      );
    }

    return { results, next_cursor: data.nextCursor };
  },

  format: (result) => {
    const lines: string[] = [
      `## CourtListener Judge Search`,
      `**Returned:** ${result.results.length}`,
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
        const title = pos.position_type ?? pos.job_title ?? 'Unknown';
        const where = pos.court ?? pos.organization_name;
        lines.push(
          `**Current position:** ${title}${where ? ` at ${where}` : ''}${pos.court_id ? ` (${pos.court_id})` : ''}${pos.appointer ? `, appointed by ${pos.appointer}` : ''}${pos.date_start ? ` (since ${pos.date_start})` : ''}`,
        );
        // Render both title/place variants so neither surface loses a field the other carries.
        if (pos.job_title && pos.position_type) lines.push(`**Job title:** ${pos.job_title}`);
        if (pos.organization_name && pos.court) {
          lines.push(`**Organization:** ${pos.organization_name}`);
        }
        if (pos.selection_method) lines.push(`**Selection method:** ${pos.selection_method}`);
        if (pos.date_termination) {
          lines.push(
            `**Ended:** ${pos.date_termination}${pos.termination_reason ? ` — ${pos.termination_reason}` : ''}`,
          );
        } else if (pos.termination_reason) {
          lines.push(`**Termination reason:** ${pos.termination_reason}`);
        }
      }
    }

    if (result.next_cursor) {
      lines.push(`\n**Next page cursor:** \`${result.next_cursor}\``);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
