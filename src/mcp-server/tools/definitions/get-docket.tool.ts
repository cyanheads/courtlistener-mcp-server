/**
 * @fileoverview Fetch full docket metadata and entry list for a single federal case.
 * @module mcp-server/tools/definitions/get-docket.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { resolveCourtName } from '@/services/courtlistener/court-names.js';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

/** CourtListener serves `filepath_local` as a relative RECAP path; make it a directly fetchable URL. */
function toStorageUrl(path: string | null): string | null {
  if (!path) return null;
  return /^https?:\/\//.test(path) ? path : `https://storage.courtlistener.com/${path}`;
}

export const getDocketTool = tool('courtlistener_get_docket', {
  title: 'Get Docket',
  description:
    'Fetch full docket metadata and entry list for a single federal case by docket ID. Returns all available docket entries with document availability status. Documents with is_available=true have a RECAP-stored copy; others require a PACER account. Obtain docket IDs from courtlistener_search_dockets or from opinion results.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    docket_id: z
      .number()
      .int()
      .describe(
        "Docket ID from a search result's docket_id field or from an opinion cluster result.",
      ),
    entries_page_size: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(20)
      .describe(
        'Number of docket entries to return (1–50). Large cases can have hundreds of entries.',
      ),
  }),

  output: z.object({
    docket_id: z.number().describe('Docket ID.'),
    case_name: z.string().describe('Short case name.'),
    case_name_full: z.string().describe('Full case name.'),
    court: z
      .string()
      .describe('Court display name for major federal courts; the court identifier otherwise.'),
    court_id: z.string().describe('Court identifier — the stable value for filtering.'),
    date_filed: z.string().describe('Date the case was filed.'),
    date_terminated: z
      .string()
      .nullable()
      .describe('Date the case was terminated; null if active.'),
    docket_number: z.string().describe('Docket number.'),
    pacer_case_id: z.string().nullable().describe('PACER case ID; null if not in RECAP.'),
    assigned_to: z.string().nullable().describe('Assigned judge name; null if not recorded.'),
    referred_to: z.string().nullable().describe('Referred judge name; null if not recorded.'),
    cause: z.string().describe('Legal cause of action.'),
    jury_demand: z.string().describe('Jury demand status.'),
    jurisdiction_type: z.string().describe('Jurisdiction type.'),
    total_entries: z
      .number()
      .describe('Total number of docket entries available — may exceed the returned entries list.'),
    entries: z
      .array(
        z
          .object({
            id: z.number().describe('Docket entry ID.'),
            entry_number: z
              .number()
              .nullable()
              .describe('PACER entry number; null if not assigned.'),
            date_filed: z.string().describe('Date this entry was filed.'),
            description: z.string().describe('Entry description or filing type.'),
            documents: z
              .array(
                z
                  .object({
                    id: z.number().describe('Document ID.'),
                    document_number: z
                      .string()
                      .nullable()
                      .describe(
                        'PACER document number as a string (e.g. "1"); attachments can be non-integer like "70-1". Null if not assigned.',
                      ),
                    attachment_number: z
                      .number()
                      .nullable()
                      .describe('Attachment number; null for the main document.'),
                    description: z.string().describe('Document description.'),
                    is_available: z
                      .boolean()
                      .describe(
                        'True if the document is available via RECAP without a PACER account.',
                      ),
                    page_count: z.number().nullable().describe('Page count; null if not recorded.'),
                    filepath_local: z
                      .string()
                      .nullable()
                      .describe(
                        'Fully-qualified RECAP storage URL (https://storage.courtlistener.com/...) for the document; null if not available.',
                      ),
                  })
                  .describe('Document attached to a docket entry.'),
              )
              .describe('Documents attached to this docket entry.'),
          })
          .describe('Docket entry with attached documents.'),
      )
      .describe('Docket entries up to entries_page_size.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Docket ID does not exist in CourtListener.',
      recovery:
        'Verify the docket ID from courtlistener_search_dockets. The docket may not be in RECAP coverage.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: '429 response from CourtListener.',
      retryable: true,
      recovery: 'Wait for the Retry-After period. Free tier: 5 req/min, 50/hr, 125/day.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_get_docket', {
      docket_id: input.docket_id,
      entries_page_size: input.entries_page_size,
    });
    const svc = getCourtListenerService();
    const docket = await svc.getDocket(input.docket_id, input.entries_page_size, ctx);

    const entries = (docket.docket_entries ?? []).map((e) => ({
      id: e.id,
      entry_number: e.entry_number ?? null,
      date_filed: e.date_filed ?? '',
      description: e.description ?? '',
      documents: (e.recap_documents ?? []).map((d) => ({
        id: d.id,
        // /docket-entries/ sends document_number as a string ("1"); normalize to a string
        // (preserving non-integer attachment forms like "70-1") rather than coercing to a number.
        document_number: d.document_number == null ? null : String(d.document_number),
        attachment_number: d.attachment_number ?? null,
        description: d.description ?? '',
        is_available: d.is_available ?? false,
        page_count: d.page_count ?? null,
        filepath_local: toStorageUrl(d.filepath_local ?? null),
      })),
    }));

    ctx.log.info('courtlistener_get_docket complete', {
      docket_id: input.docket_id,
      entries_returned: entries.length,
      entries_total: docket.docket_entries_count,
    });

    return {
      docket_id: docket.id,
      case_name: docket.case_name ?? '',
      case_name_full: docket.case_name_full ?? '',
      court: resolveCourtName(docket.court_id),
      court_id: docket.court_id ?? '',
      date_filed: docket.date_filed ?? '',
      date_terminated: docket.date_terminated ?? null,
      docket_number: docket.docket_number ?? '',
      pacer_case_id: docket.pacer_case_id ?? null,
      assigned_to: docket.assigned_to_str ?? null,
      referred_to: docket.referred_to_str ?? null,
      cause: docket.cause ?? '',
      jury_demand: docket.jury_demand ?? '',
      jurisdiction_type: docket.jurisdiction_type ?? '',
      total_entries: docket.docket_entries_count ?? entries.length,
      entries,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## ${result.case_name}`,
      `**Docket ID:** ${result.docket_id} | **Court:** ${result.court} (${result.court_id})`,
      `**Docket #:** ${result.docket_number} | **Filed:** ${result.date_filed}${result.date_terminated ? ` | **Terminated:** ${result.date_terminated}` : ''}`,
    ];

    if (result.case_name_full && result.case_name_full !== result.case_name) {
      lines.push(`*${result.case_name_full}*`);
    }
    if (result.assigned_to) lines.push(`**Judge:** ${result.assigned_to}`);
    if (result.referred_to) lines.push(`**Referred to:** ${result.referred_to}`);
    if (result.cause) lines.push(`**Cause:** ${result.cause}`);
    if (result.jury_demand) lines.push(`**Jury demand:** ${result.jury_demand}`);
    if (result.jurisdiction_type) lines.push(`**Jurisdiction:** ${result.jurisdiction_type}`);
    if (result.pacer_case_id) lines.push(`**PACER ID:** ${result.pacer_case_id}`);
    lines.push(`**Total entries:** ${result.total_entries}`);

    if (result.entries.length > 0) {
      lines.push('\n### Docket Entries');
      for (const e of result.entries) {
        lines.push(
          `\n**Entry ID:** ${e.id} | **#${e.entry_number ?? 'N/A'}** (${e.date_filed}): ${e.description}`,
        );
        for (const d of e.documents) {
          const avail = d.is_available
            ? `[available${d.filepath_local ? `: ${d.filepath_local}` : ''}]`
            : '[requires PACER]';
          const pages = d.page_count != null ? `, ${d.page_count}pp` : '';
          const attach = d.attachment_number != null ? ` attachment #${d.attachment_number}` : '';
          lines.push(
            `  - Doc ID ${d.id} #${d.document_number ?? 'N/A'}${attach}: ${d.description}${pages} ${avail}`,
          );
        }
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
