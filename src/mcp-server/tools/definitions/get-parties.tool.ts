/**
 * @fileoverview Fetch parties and attorneys of record for a RECAP federal docket.
 * @module mcp-server/tools/definitions/get-parties.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import {
  formatPageSizing,
  PageSizing,
  pageSizing,
} from '@/services/courtlistener/page-metadata.js';

export const getPartiesTool = tool('courtlistener_get_parties', {
  title: 'Get Parties',
  description:
    'Fetch a page of parties and their attorneys of record for a RECAP federal docket by docket ID. ' +
    "Returns each party's name, role (Plaintiff, Defendant, Petitioner, Respondent, etc.), and their attorneys with contact information, scoped to this docket. " +
    'Costs one party request plus up to five attorney roster requests. A later roster page blocked by the local request budget returns fetched detail with capped resolution, unresolved IDs, and the remaining roster cursor. ' +
    'Obtain docket IDs from courtlistener_search_dockets or courtlistener_get_docket.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    docket_id: z
      .number()
      .int()
      .describe(
        "Docket ID from a courtlistener_search_dockets or courtlistener_get_docket result's docket_id field.",
      ),
    cursor: z
      .string()
      .optional()
      .describe(
        "Pagination cursor from a previous response's next_cursor field. Omit for the first page. This is an opaque token, not a page number — CourtListener cursor-paginates this endpoint, so a numeric value selects nothing and re-serves the first page.",
      ),
    page_size: z
      .number()
      .int()
      .min(1)
      .optional()
      .default(10)
      .describe(
        'Positive requested party page size (default 10), bounded to 10 before retrieval. CourtListener uses fixed 20-row pages and ignores this request; final pages can be smaller. page_sizing reports requested, bounded and actual sizes.',
      ),
  }),

  output: z.object({
    page_sizing: PageSizing.optional(),
    attorney_resolution: z
      .object({
        status: z
          .enum(['resolved', 'exhausted', 'capped'])
          .describe(
            'Resolved all needed IDs, exhausted roster with misses, or stopped at the page cap.',
          ),
        unresolved_ids: z
          .array(z.number())
          .describe('Attorney IDs still unresolved on this parties page.'),
        next_cursor: z
          .string()
          .nullable()
          .describe('Remaining attorney-roster cursor; null when exhausted.'),
      })
      .optional()
      .describe('Attorney lookup completeness; no additional automatic requests are made.'),
    docket_id: z.number().describe('Docket ID these parties belong to.'),
    total_parties: z
      .number()
      .nullable()
      .describe(
        'Total parties on this docket across all pages; null when no total is derivable — CourtListener serves the count as a URL rather than a number here, so it is only known when the first page is also the last.',
      ),
    next_cursor: z
      .string()
      .nullable()
      .describe(
        'Opaque pagination cursor for the next page — pass it back as the `cursor` argument; null when this is the last page.',
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
                    resolution: z
                      .enum(['resolved', 'not_found', 'not_fetched'])
                      .optional()
                      .describe(
                        'Whether detail was resolved (possibly with empty source fields), absent from an exhausted roster, or unknown after the cap.',
                      ),
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
        'Total parties on this docket across all pages — this endpoint reports its count as a URL rather than a number, so the total is only derivable when the first page is also the last, and is absent for any list spanning more than one page.',
      ),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Docket ID does not exist in CourtListener or has no RECAP party data.',
      recovery:
        'Verify the docket ID via courtlistener_search_dockets. Parties data requires RECAP coverage for the docket.',
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: '429 from CourtListener, or no request slot opened before any attorney roster page completed.',
      retryable: false,
      recovery:
        'Wait out the Retry-After interval reported on the error before calling again. CourtListener throttles per minute, hour, and day; party and attorney requests share that budget.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_get_parties', {
      docket_id: input.docket_id,
      has_cursor: input.cursor !== undefined,
      page_size: input.page_size,
    });
    const svc = getCourtListenerService();
    const result = await svc.getParties(
      input.docket_id,
      input.cursor,
      Math.min(input.page_size, 10),
      ctx,
    );

    ctx.log.info('courtlistener_get_parties complete', {
      docket_id: input.docket_id,
      total_parties: result.count,
      parties_returned: result.parties.length,
    });

    if (result.count !== null) ctx.enrich.total(result.count);

    return {
      docket_id: input.docket_id,
      total_parties: result.count,
      next_cursor: result.next_cursor,
      parties: result.parties,
      attorney_resolution: result.attorney_resolution,
      page_sizing: pageSizing(input.page_size, 10, result.parties.length, 'fixed_20'),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Parties — Docket ${result.docket_id}`,
      formatPageSizing(result.page_sizing),
      ...(result.attorney_resolution
        ? [
            `**Attorney resolution:** ${result.attorney_resolution.status}; unresolved IDs: ${result.attorney_resolution.unresolved_ids.join(', ') || 'none'}; roster cursor: ${result.attorney_resolution.next_cursor ?? 'none'}.`,
          ]
        : []),
      `**Total parties:** ${result.total_parties ?? 'unknown'} | **Next cursor:** ${result.next_cursor ?? 'none'}`,
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
            if (att.resolution) lines.push(`  Resolution: ${att.resolution}`);
          }
        }
      }
    }

    if (result.next_cursor) {
      lines.push(`\n*More parties available — pass cursor=${result.next_cursor} to continue.*`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
