/**
 * @fileoverview Fetch parties and attorneys of record for a RECAP federal docket.
 * @module mcp-server/tools/definitions/get-parties.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

export const getPartiesTool = tool('courtlistener_get_parties', {
  title: 'Get Parties',
  description:
    'Fetch all parties and attorneys of record for a RECAP federal docket by docket ID. ' +
    "Returns each party's name, role (Plaintiff, Defendant, Petitioner, Respondent, etc.), and their attorneys with contact information, scoped to this docket. " +
    'Costs two upstream requests per call (parties + attorney lookup) against a rate-limited free tier, and one more for each extra page of a large attorney roster. ' +
    'Obtain docket IDs from courtlistener_search_dockets or courtlistener_get_docket.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    docket_id: z
      .number()
      .int()
      .describe(
        "Docket ID from a courtlistener_search_dockets or courtlistener_get_docket result's docket_id field.",
      ),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .default(1)
      .describe('Page number (1-indexed). Use with page_size to paginate large party lists.'),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .default(10)
      .describe(
        'Requested number of parties per page (1–10). CourtListener paginates this endpoint at a fixed size and does not honor the requested value, so a page can come back larger than asked for.',
      ),
  }),

  output: z.object({
    docket_id: z.number().describe('Docket ID these parties belong to.'),
    total_parties: z
      .number()
      .nullable()
      .describe(
        'Total parties on this docket across all pages; null when upstream reports no count (a multi-page list whose total is unknown until the last page).',
      ),
    page: z.number().describe('Current page number.'),
    next_cursor: z
      .string()
      .nullable()
      .describe(
        'Next page number to pass as the `page` argument (this list is page-paginated); null when this is the last page.',
      ),
    parties: z
      .array(
        z
          .object({
            id: z.number().describe('Party record ID.'),
            name: z.string().describe('Party display name (e.g., "Jane Doe", "Acme Corporation").'),
            role: z
              .string()
              .nullable()
              .describe(
                'Role on this docket (e.g., "Plaintiff", "Defendant", "Petitioner", "Respondent"); null if not recorded.',
              ),
            extra_info: z
              .string()
              .describe('Additional metadata from upstream (e.g., pro se status, date range).'),
            attorneys: z
              .array(
                z
                  .object({
                    attorney_id: z.number().describe('Attorney record ID.'),
                    name: z
                      .string()
                      .describe(
                        'Attorney display name. Empty string when attorney detail is unavailable.',
                      ),
                    contact_raw: z
                      .string()
                      .describe(
                        'Raw address/phone block from the attorney record. Empty string when unavailable.',
                      ),
                    role_code: z
                      .number()
                      .nullable()
                      .describe(
                        'Numeric attorney role code from the party–attorney relationship (1 = Attorney to be noticed, 2 = Lead attorney, 3 = Attorney in sealed group, 4 = Pro hac vice, 5 = Self-terminated, 6 = Terminated, 7 = Suspended, 8 = Inactive, 9 = Disbarred, 10 = Unknown); null when upstream recorded no code.',
                      ),
                    role: z
                      .string()
                      .describe(
                        'role_code decoded to a label (e.g., "Lead attorney"). Codes 5–9 ("Self-terminated" through "Disbarred") mean the attorney is no longer of record. The stringified code when upstream sends a value outside the documented enum, "Unrecorded" when it sends none.',
                      ),
                    date_action: z
                      .string()
                      .nullable()
                      .describe(
                        'Date the attorney–party relationship ended; null while the attorney is still of record.',
                      ),
                  })
                  .describe('Attorney of record for this party.'),
              )
              .describe('Attorneys of record for this party on this docket.'),
          })
          .describe('A party and their attorneys for this docket.'),
      )
      .describe('Parties on this page.'),
  }),

  // Surfaces the upstream party total on both response surfaces so the agent
  // knows when a page_size-capped page is a partial view of the full list.
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe(
        'Total parties on this docket across all pages — present only when the API reports a numeric count (this endpoint returns it as a URL by default, so it is absent for any list spanning more than one page).',
      ),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Docket ID does not exist in CourtListener or has no RECAP party data.',
      recovery:
        'Verify the docket ID via courtlistener_search_dockets. Parties data requires RECAP coverage for the docket.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: '429 response from CourtListener. Each call to this tool makes at least two upstream requests.',
      retryable: false,
      recovery:
        'Wait out the Retry-After interval reported on the error before calling again. CourtListener throttles per minute, hour, and day, so an immediate retry fails; this tool costs at least 2 requests per call.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_get_parties', {
      docket_id: input.docket_id,
      page: input.page,
      page_size: input.page_size,
    });
    const svc = getCourtListenerService();
    const result = await svc.getParties(input.docket_id, input.page, input.page_size, ctx);

    ctx.log.info('courtlistener_get_parties complete', {
      docket_id: input.docket_id,
      total_parties: result.count,
      parties_returned: result.parties.length,
    });

    if (result.count !== null) ctx.enrich.total(result.count);

    return {
      docket_id: input.docket_id,
      total_parties: result.count,
      page: input.page,
      next_cursor: result.next_cursor,
      parties: result.parties,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Parties — Docket ${result.docket_id}`,
      `**Total parties:** ${result.total_parties ?? 'unknown'} | **Page:** ${result.page} | **Next cursor:** ${result.next_cursor ?? 'none'}`,
    ];

    if (result.parties.length === 0) {
      lines.push('\n*No party data available for this docket.*');
    } else {
      for (const party of result.parties) {
        lines.push('');
        const roleStr = party.role ? ` (${party.role})` : '';
        lines.push(`### Party ID ${party.id}: ${party.name}${roleStr}`);
        if (party.extra_info) lines.push(`*${party.extra_info}*`);
        if (party.attorneys.length === 0) {
          lines.push('No attorneys of record.');
        } else {
          lines.push('**Attorneys:**');
          for (const att of party.attorneys) {
            const name = att.name || `Attorney ID ${att.attorney_id}`;
            const ended = att.date_action ? `, ended ${att.date_action}` : '';
            lines.push(
              `- ${name} (ID: ${att.attorney_id}, ${att.role} [code ${att.role_code ?? 'none'}]${ended})`,
            );
            if (att.contact_raw) lines.push(`  ${att.contact_raw}`);
          }
        }
      }
    }

    if (result.next_cursor) {
      lines.push(`\n*More parties available — pass page=${result.page + 1} to continue.*`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
