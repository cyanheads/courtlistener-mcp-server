/**
 * @fileoverview Resolve a legal citation string to a CourtListener cluster ID and case metadata.
 * @module mcp-server/tools/definitions/lookup-citation.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

export const lookupCitationTool = tool('courtlistener_lookup_citation', {
  title: 'Lookup Legal Citation',
  description:
    'Resolve a formatted legal citation string (e.g., "410 U.S. 113", "93 S. Ct. 705") to a cluster ID and case metadata. Enables workflows that start from a known citation rather than a search query. Supports standard US reporter formats. Requires authentication — uses the CourtListener /citation-lookup/ endpoint.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    citation: z
      .string()
      .trim()
      .describe(
        'Legal citation string to resolve (e.g., "410 U.S. 113", "347 U.S. 483", "93 S. Ct. 705"). Supports standard reporter formats.',
      ),
  }),

  output: z.object({
    cluster_id: z
      .number()
      .nullable()
      .describe('Opinion cluster ID — null if the citation is not in the CourtListener database.'),
    case_name: z.string().nullable().describe('Case name; null if not found.'),
    court: z.string().nullable().describe('Court display name; null if not found.'),
    date_filed: z.string().nullable().describe('Date the opinion was filed; null if not found.'),
    citations: z.array(z.string()).describe('All known citation strings for this case.'),
    normalized_citation: z
      .string()
      .nullable()
      .describe('Canonical citation form used by CourtListener; null if not resolved.'),
  }),

  // Agent-facing context: echoed input citation and a recovery hint when not resolved.
  enrichment: {
    queriedCitation: z.string().describe('The citation string that was looked up.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when the citation is not in the database — suggests alternative lookup strategies.',
      ),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Citation string is not in the CourtListener database.',
      recovery:
        'Verify the citation format (volume reporter page). Try courtlistener_search_opinions with the case name instead.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: '429 response from CourtListener.',
      retryable: false,
      recovery:
        'Wait out the Retry-After interval reported on the error before calling again. CourtListener throttles per minute, hour, and day, so an immediate retry fails.',
    },
    {
      reason: 'empty_citation',
      code: JsonRpcErrorCode.ValidationError,
      when: 'citation is empty or whitespace-only after trimming — no request is sent.',
      recovery: 'Supply a citation in volume-reporter-page form, for example "410 U.S. 113".',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_lookup_citation', { citation: input.citation });

    // Guard before the service call: a blank citation would otherwise spend one of
    // the free tier's 125 daily requests and cannot resolve.
    if (!input.citation) {
      throw ctx.fail(
        'empty_citation',
        'The citation parameter is empty or whitespace-only. Supply a citation string — e.g. citation: "410 U.S. 113".',
      );
    }

    const svc = getCourtListenerService();

    const result = await svc.lookupCitation(input.citation, ctx);

    ctx.log.info('courtlistener_lookup_citation complete', {
      found: result.cluster_id != null,
      cluster_id: result.cluster_id,
    });

    ctx.enrich({ queriedCitation: input.citation });
    if (result.cluster_id == null) {
      ctx.enrich.notice(
        `Citation "${input.citation}" not found in CourtListener. Verify the reporter format (volume reporter page) or try courtlistener_search_opinions with the case name.`,
      );
    }

    return {
      cluster_id: result.cluster_id,
      case_name: result.case_name,
      court: result.court,
      date_filed: result.date_filed,
      citations: result.citations,
      normalized_citation: result.normalized_citation,
    };
  },

  format: (result) => {
    const lines: string[] = [`## Citation Lookup`];

    if (result.cluster_id == null) {
      lines.push('> Citation not found in CourtListener database.');
      lines.push(
        '> Verify the citation format or try courtlistener_search_opinions with the case name.',
      );
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push(`**Cluster ID:** ${result.cluster_id}`);
    if (result.case_name) lines.push(`**Case:** ${result.case_name}`);
    if (result.court) lines.push(`**Court:** ${result.court}`);
    if (result.date_filed) lines.push(`**Filed:** ${result.date_filed}`);
    if (result.normalized_citation) lines.push(`**Normalized:** ${result.normalized_citation}`);
    if (result.citations.length > 0)
      lines.push(`**All citations:** ${result.citations.join(', ')}`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
