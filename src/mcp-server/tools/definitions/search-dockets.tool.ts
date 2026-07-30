/**
 * @fileoverview Search RECAP federal court dockets via CourtListener.
 * @module mcp-server/tools/definitions/search-dockets.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import { findInvalidDates, ISO_DATE_HINT } from '@/services/courtlistener/dates.js';
import { toStorageUrl } from '@/services/courtlistener/uri.js';

const COVERAGE_NOTE =
  'RECAP coverage is partial. Documents with is_available=false require a PACER account or CourtListener RECAP filing — fetching their PDFs is not exposed by this server.';

export const searchDocketsTool = tool('courtlistener_search_dockets', {
  title: 'Search Federal Court Dockets',
  description:
    'Search RECAP federal court dockets. Query terms match case name, docket number, party, and attorney names; filters narrow by party name, court, and filing date. RECAP is a crowd-sourced mirror of PACER (the federal court filing system) — coverage varies by court and date. Returns docket metadata with the parties, attorneys, and firms of record, plus up to 3 sample document entries per docket. Use courtlistener_lookup_courts to find court IDs.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },

  input: z.object({
    q: z
      .string()
      .trim()
      .describe(
        'Query terms matched against case name, docket number, party names, and attorney names. Example: "Apple Inc patent infringement".',
      ),
    court: z
      .string()
      .optional()
      .describe(
        'Filter to a specific federal court ID (e.g., "dnd", "cacd", "deb" for Delaware Bankruptcy). Use courtlistener_lookup_courts to find court IDs.',
      ),
    party_name: z
      .string()
      .optional()
      .describe(
        'Filter to dockets listing a specific party by name — applied in addition to (AND with) the q query. More precise than including party names in q when the party name is known.',
      ),
    filed_after: z.string().optional().describe('Earliest case filing date (ISO 8601).'),
    filed_before: z.string().optional().describe('Latest case filing date (ISO 8601).'),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(20)
      .describe(
        'Number of results to request (default 20). CourtListener search enforces a minimum of 20 results per page regardless of the value passed — you will always receive at least 20 results.',
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
            docket_id: z
              .number()
              .describe('Docket ID — pass to courtlistener_get_docket for full entry list.'),
            case_name: z.string().describe('Case name.'),
            case_name_full: z
              .string()
              .describe('Full case name with all parties; empty string when not recorded.'),
            court: z.string().describe('Court display name.'),
            court_id: z.string().describe('Court identifier.'),
            date_filed: z.string().describe('Date the case was filed.'),
            date_terminated: z
              .string()
              .nullable()
              .describe('Date the case was terminated; null if still active.'),
            docket_number: z.string().describe('Docket number.'),
            pacer_case_id: z
              .string()
              .nullable()
              .describe('PACER case ID; null if not available in RECAP.'),
            assigned_to: z
              .string()
              .nullable()
              .describe('Assigned judge name; null if not recorded.'),
            referred_to: z
              .string()
              .nullable()
              .describe('Referred magistrate judge name; null if not recorded.'),
            cause: z.string().describe('Legal cause of action.'),
            jury_demand: z.string().describe('Jury demand status.'),
            suit_nature: z
              .string()
              .describe(
                'Nature-of-suit label, usually prefixed with its PACER code (e.g. "830 Patent"); empty string when not recorded.',
              ),
            jurisdiction_type: z
              .string()
              .describe(
                'Basis of federal jurisdiction (e.g. "Federal Question"); empty string when not recorded.',
              ),
            parties: z.array(z.string()).describe('Party names listed in this docket.'),
            attorneys: z
              .array(z.string())
              .describe('Attorney names of record on this docket; empty when none are recorded.'),
            firms: z
              .array(z.string())
              .describe('Law firm names of record on this docket; empty when none are recorded.'),
            sample_documents: z
              .array(
                z
                  .object({
                    id: z.number().describe('Document ID.'),
                    description: z.string().describe('Document description or title.'),
                    date_filed: z
                      .string()
                      .describe(
                        'Date the parent docket entry was filed; empty string when not recorded.',
                      ),
                    document_number: z
                      .number()
                      .nullable()
                      .describe('PACER document number; null if not assigned.'),
                    entry_number: z
                      .number()
                      .nullable()
                      .describe(
                        'Docket entry number this document belongs to; null if unnumbered.',
                      ),
                    document_type: z
                      .string()
                      .describe(
                        'Document classification (e.g. "PACER Document", "RECAP Document"); empty string when not recorded.',
                      ),
                    page_count: z.number().nullable().describe('Page count; null if not recorded.'),
                    filepath_local: z
                      .string()
                      .nullable()
                      .describe(
                        'Fully-qualified RECAP storage URL (https://storage.courtlistener.com/...) for the document; null when no copy is stored.',
                      ),
                    is_available: z
                      .boolean()
                      .describe(
                        'True if the document is available via RECAP without a PACER account.',
                      ),
                  })
                  .describe('Sample document entry.'),
              )
              .describe(
                "Up to 3 sample filings matched on this docket — a search excerpt, not the docket's full filing list. Call courtlistener_get_docket for every entry.",
              ),
          })
          .describe('Docket search result.'),
      )
      .describe('Matching docket records.'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Pagination cursor for the next page; null when no more results.'),
    coverage_note: z.string().describe('Note about RECAP coverage limitations.'),
  }),

  // Agent-facing context: total match count and recovery hint on empty pages.
  enrichment: {
    totalCount: z.number().describe('Total matching dockets.'),
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
      recovery:
        'Supply search terms in q — a case name, party name, docket number, or attorney name.',
    },
    {
      reason: 'invalid_date',
      code: JsonRpcErrorCode.ValidationError,
      when: 'filed_after or filed_before is not a valid ISO 8601 calendar date.',
      recovery: 'Pass each date filter as a real YYYY-MM-DD calendar date, for example 2020-01-01.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_search_dockets', { q: input.q, court: input.court });

    // Guard before the service call: both rejections would otherwise spend one of the
    // free tier's published 125 daily requests (actual limits vary by token tier) on
    // input that cannot return useful data.
    if (!input.q) {
      throw ctx.fail(
        'empty_query',
        'The q parameter is empty or whitespace-only. Supply search terms — e.g. q: "Apple Inc patent infringement".',
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

    const data = await svc.searchDockets(
      {
        q: input.q,
        court: input.court,
        party_name: input.party_name,
        filed_after: input.filed_after,
        filed_before: input.filed_before,
        page_size: input.page_size,
        cursor: input.cursor,
      },
      ctx,
    );

    const results = data.results.map((r) => ({
      docket_id: r.docket_id,
      case_name: r.caseName ?? '',
      case_name_full: r.case_name_full ?? '',
      court: r.court ?? '',
      court_id: r.court_id ?? '',
      date_filed: r.dateFiled ?? '',
      date_terminated: r.dateTerminated ?? null,
      docket_number: r.docketNumber ?? '',
      pacer_case_id: r.pacer_case_id ?? null,
      assigned_to: r.assignedTo ?? null,
      referred_to: r.referredTo ?? null,
      cause: r.cause ?? '',
      jury_demand: r.juryDemand ?? '',
      suit_nature: r.suitNature ?? '',
      jurisdiction_type: r.jurisdictionType ?? '',
      parties: r.party ?? [],
      attorneys: r.attorney ?? [],
      firms: r.firm ?? [],
      sample_documents: (r.recap_documents ?? []).slice(0, 3).map((d) => ({
        id: d.id,
        description: d.description ?? '',
        date_filed: d.entry_date_filed ?? '',
        document_number: d.document_number ?? null,
        entry_number: d.entry_number ?? null,
        document_type: d.document_type ?? '',
        page_count: d.page_count ?? null,
        filepath_local: toStorageUrl(d.filepath_local ?? null),
        is_available: d.is_available ?? false,
      })),
    }));

    ctx.log.info('courtlistener_search_dockets complete', {
      total: data.total,
      returned: results.length,
    });

    ctx.enrich.total(data.total);
    if (results.length === 0) {
      const filters: string[] = [];
      if (input.court) filters.push(`court="${input.court}"`);
      if (input.party_name) filters.push(`party="${input.party_name}"`);
      if (input.filed_after) filters.push(`filed_after=${input.filed_after}`);
      if (input.filed_before) filters.push(`filed_before=${input.filed_before}`);
      const filterHint = filters.length > 0 ? ` with filters: ${filters.join(', ')}` : '';
      ctx.enrich.notice(
        `No dockets matched "${input.q}"${filterHint}. Try broadening filters or revising search terms.`,
      );
    }

    return {
      results,
      next_cursor: data.nextCursor,
      coverage_note: COVERAGE_NOTE,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## CourtListener Docket Search`,
      `**Returned:** ${result.results.length}`,
      `\n> ${result.coverage_note}`,
    ];

    if (result.results.length === 0) {
      lines.push(
        '\n> No dockets matched the query. Try broadening filters or revising search terms.',
      );
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const r of result.results) {
      lines.push(`\n### ${r.case_name}`);
      if (r.case_name_full && r.case_name_full !== r.case_name) {
        lines.push(`*${r.case_name_full}*`);
      }
      lines.push(`**Docket ID:** ${r.docket_id} | **Court:** ${r.court} (${r.court_id})`);
      lines.push(
        `**Docket #:** ${r.docket_number} | **Filed:** ${r.date_filed}${r.date_terminated ? ` | **Terminated:** ${r.date_terminated}` : ''}`,
      );
      if (r.assigned_to) lines.push(`**Judge:** ${r.assigned_to}`);
      if (r.referred_to) lines.push(`**Referred to:** ${r.referred_to}`);
      if (r.cause) lines.push(`**Cause:** ${r.cause}`);
      if (r.suit_nature) lines.push(`**Nature of suit:** ${r.suit_nature}`);
      if (r.jurisdiction_type) lines.push(`**Jurisdiction:** ${r.jurisdiction_type}`);
      if (r.jury_demand) lines.push(`**Jury demand:** ${r.jury_demand}`);
      if (r.parties.length > 0) lines.push(`**Parties:** ${r.parties.join(', ')}`);
      if (r.attorneys.length > 0) lines.push(`**Attorneys:** ${r.attorneys.join(', ')}`);
      if (r.firms.length > 0) lines.push(`**Firms:** ${r.firms.join(', ')}`);
      if (r.pacer_case_id) lines.push(`**PACER ID:** ${r.pacer_case_id}`);

      if (r.sample_documents.length > 0) {
        lines.push('**Sample documents:**');
        for (const d of r.sample_documents) {
          const avail = d.is_available ? '[available]' : '[requires PACER]';
          const entry = d.entry_number != null ? ` entry #${d.entry_number}` : '';
          const pages = d.page_count != null ? `, ${d.page_count}pp` : '';
          const type = d.document_type ? ` [${d.document_type}]` : '';
          lines.push(
            `  - ID ${d.id} #${d.document_number ?? 'N/A'}${entry}: ${d.description} (${d.date_filed})${pages}${type} ${avail}`,
          );
          if (d.filepath_local) lines.push(`    ${d.filepath_local}`);
        }
      }
    }

    if (result.next_cursor) {
      lines.push(`\n**Next page cursor:** \`${result.next_cursor}\``);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
