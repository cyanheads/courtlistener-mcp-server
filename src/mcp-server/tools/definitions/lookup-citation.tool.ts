/**
 * @fileoverview Resolve every legal citation in a text to CourtListener cluster IDs and
 * case metadata.
 * @module mcp-server/tools/definitions/lookup-citation.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { expandCode } from '@/services/courtlistener/codes.js';
import {
  COURT_BACKFILL_LIMIT,
  getCourtListenerService,
} from '@/services/courtlistener/courtlistener-service.js';

/**
 * Per-citation resolution statuses `/citation-lookup/` returns (`CitationLookupViewSet`
 * in cl/citations/api_views.py). They are HTTP status codes reused as per-entry outcomes
 * inside a 200 response, so they describe one citation, never the request as a whole.
 */
const CITATION_STATUS_LABELS: Record<string, string> = {
  200: 'Resolved to one case',
  300: 'Ambiguous — several candidate cases',
  400: 'Unrecognized reporter',
  404: 'No case found for this citation',
  429: 'Skipped — past the per-request citation cap',
};

/**
 * Upstream's own ceiling on the submitted text: `CitationAPIRequestSerializer.text` is
 * `CharField(max_length=64_000)` (cl/citations/api_serializers.py). Anything longer is
 * rejected by CourtListener after the request is already spent, so it is checked here.
 */
const MAX_CITATION_TEXT_CHARS = 64_000;

/** One case a citation resolved to. A citation with status 300 carries several. */
const CitationCluster = z
  .object({
    cluster_id: z
      .number()
      .nullable()
      .describe(
        'Opinion cluster ID — pass to courtlistener_get_opinion. Null when upstream sent no ID.',
      ),
    case_name: z.string().nullable().describe('Case name; null if not recorded.'),
    court: z
      .string()
      .nullable()
      .describe(
        `Court display name. The citation-lookup payload carries no court, so this is resolved from the cluster's docket — one extra request each, capped at ${COURT_BACKFILL_LIMIT} distinct dockets per call. Null when that lookup was skipped past the cap, failed, or the cluster has no docket_id; the response notice reports how many clusters were left unresolved. Pass docket_id to courtlistener_get_docket, or cluster_id to courtlistener_get_opinion, to resolve one.`,
      ),
    court_id: z
      .string()
      .nullable()
      .describe(
        'Court identifier for the `court` filter on the search tools (e.g. "scotus"); null under the same conditions as `court`.',
      ),
    date_filed: z.string().nullable().describe('Date the opinion was filed; null if not recorded.'),
    docket_id: z
      .number()
      .nullable()
      .describe('Linked docket — pass to courtlistener_get_docket. Null if not recorded.'),
    citations: z.array(z.string()).describe('All known citation strings for this case.'),
    cite_count: z
      .number()
      .nullable()
      .describe(
        'Times other opinions cite this case — a rough authority weight. Null if not recorded.',
      ),
    precedential_status: z
      .string()
      .nullable()
      .describe('Publication status (e.g. "Published", "Unpublished"); null if not recorded.'),
    judges: z.string().nullable().describe('Free-text judge names; null or empty if not recorded.'),
  })
  .describe('An opinion cluster this citation resolved to.');

/** One citation upstream extracted from the input, with everything it resolved to. */
const CitationMatch = z
  .object({
    citation: z
      .string()
      .describe('The citation as CourtListener matched it in the submitted text.'),
    normalized_citation: z
      .string()
      .nullable()
      .describe('Canonical citation form used by CourtListener; null if not resolved.'),
    status: z
      .number()
      .describe(
        'Resolution status for this citation alone: 200 one case, 300 several candidates, 400 unrecognized reporter, 404 no case found, 429 past the per-request citation cap. Not the status of the request, which succeeded.',
      ),
    status_label: z.string().describe('status decoded to a label.'),
    error_message: z
      .string()
      .describe("CourtListener's explanation when status is not 200; empty string otherwise."),
    clusters: z
      .array(CitationCluster)
      .describe(
        'Cases this citation resolved to — empty when status is not 200 or 300, and more than one when status is 300.',
      ),
  })
  .describe('One citation found in the submitted text and everything it resolved to.');

export const lookupCitationTool = tool('courtlistener_lookup_citation', {
  title: 'Lookup Legal Citation',
  description: `Resolve legal citations (e.g., "410 U.S. 113", "93 S. Ct. 705") to opinion cluster IDs and case metadata. Enables workflows that start from a known citation rather than a search query. CourtListener extracts every citation it finds in the submitted text, so passing a passage returns one entry per citation, each with its own resolution status — an unresolved or ambiguous citation is reported in the results, not raised as an error. Supports standard US reporter formats. Costs one upstream request plus one per distinct docket whose court is resolved, capped at ${COURT_BACKFILL_LIMIT} dockets — at most ${COURT_BACKFILL_LIMIT + 1} requests per call. CourtListener meters this endpoint by citations submitted rather than by call, so a long passage spends proportionally more of a rate-limited free tier. Requires authentication — uses the CourtListener /citation-lookup/ endpoint.`,
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    citation: z
      .string()
      .trim()
      .describe(
        `Text to extract citations from — normally a single citation (e.g., "410 U.S. 113", "347 U.S. 483", "93 S. Ct. 705"), but any passage works and every citation in it is resolved. Supports standard reporter formats. Up to ${MAX_CITATION_TEXT_CHARS} characters, which is CourtListener's own ceiling; a longer passage is rejected here rather than spending a request to be refused upstream.`,
      ),
  }),

  output: z.object({
    matches: z
      .array(CitationMatch)
      .describe(
        'One entry per citation CourtListener extracted from the input, in the order they appear.',
      ),
  }),

  // Agent-facing context: the echoed input citation, plus caveats the result rows
  // cannot carry on their own — nothing resolved, or courts left unresolved by the cap.
  enrichment: {
    queriedCitation: z.string().describe('The citation string that was looked up.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Caveats on this result: a recovery hint when no citation in the input resolved to a case, and a count of clusters whose court the per-call docket cap left unresolved. Absent when neither applies.',
      ),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'CourtListener could not parse any citation out of the submitted text. A citation that parses but matches nothing is a result with status 404, not this error.',
      recovery:
        'Check the citation is in volume-reporter-page form, for example "410 U.S. 113". Try courtlistener_search_opinions with the case name instead.',
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
    {
      reason: 'citation_too_long',
      code: JsonRpcErrorCode.ValidationError,
      when: `citation exceeds the ${MAX_CITATION_TEXT_CHARS}-character ceiling CourtListener accepts — no request is sent.`,
      recovery: `Trim the passage to ${MAX_CITATION_TEXT_CHARS} characters or fewer, or split it and look up each part separately.`,
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_lookup_citation', { citation: input.citation });

    // Guard before the service call: both rejections would otherwise spend one of the
    // free tier's daily requests on input CourtListener will refuse anyway.
    if (!input.citation) {
      throw ctx.fail(
        'empty_citation',
        'The citation parameter is empty or whitespace-only. Supply a citation string — e.g. citation: "410 U.S. 113".',
      );
    }
    if (input.citation.length > MAX_CITATION_TEXT_CHARS) {
      throw ctx.fail(
        'citation_too_long',
        `The citation parameter is ${input.citation.length} characters; CourtListener accepts at most ${MAX_CITATION_TEXT_CHARS}. Trim the passage or split it and look up each part separately.`,
      );
    }

    const svc = getCourtListenerService();

    const found = await svc.lookupCitation(input.citation, ctx);

    // The service already speaks the output's shape; the label is the only addition.
    const matches = found.map((match) => ({
      ...match,
      status_label: expandCode(CITATION_STATUS_LABELS, match.status),
    }));

    const resolvedCount = matches.filter((m) => m.clusters.length > 0).length;

    ctx.log.info('courtlistener_lookup_citation complete', {
      citations_found: matches.length,
      citations_resolved: resolvedCount,
    });

    // A cluster that carries a docket but no court_id is one the bounded backfill did
    // not reach — the cap is a server-side decision, so without this the caller sees a
    // null court identical to one that genuinely has no court and never learns why.
    const unresolvedCourts = matches
      .flatMap((m) => m.clusters)
      .filter((c) => c.docket_id !== null && c.court_id === null).length;

    const notices: string[] = [];
    if (resolvedCount === 0) {
      const reasons = matches.map((m) => `${m.citation}: ${m.status_label}`).join('; ');
      notices.push(
        `No citation in "${input.citation}" resolved to a case (${reasons}). Verify the reporter format (volume reporter page) or try courtlistener_search_opinions with the case name.`,
      );
    }
    if (unresolvedCourts > 0) {
      notices.push(
        `Court unresolved on ${unresolvedCourts} of the returned clusters: resolving a court costs one request per docket and is capped at ${COURT_BACKFILL_LIMIT} per call, and an individual docket lookup can also fail. Pass that cluster's docket_id to courtlistener_get_docket, or its cluster_id to courtlistener_get_opinion, to resolve it.`,
      );
    }

    ctx.enrich({ queriedCitation: input.citation });
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return { matches };
  },

  format: (result) => {
    const lines: string[] = ['## Citation Lookup'];

    if (result.matches.length === 0) {
      lines.push('> No citations were extracted from the input.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const match of result.matches) {
      lines.push('');
      lines.push(`### ${match.citation}`);
      lines.push(`**Status:** ${match.status_label} (${match.status})`);
      if (match.normalized_citation) lines.push(`**Normalized:** ${match.normalized_citation}`);
      if (match.error_message) lines.push(`**Upstream message:** ${match.error_message}`);

      if (match.clusters.length === 0) {
        lines.push('No matching case — try courtlistener_search_opinions with the case name.');
        continue;
      }
      if (match.clusters.length > 1) {
        lines.push(`${match.clusters.length} candidate cases:`);
      }
      for (const cluster of match.clusters) {
        lines.push(`- **Cluster ID:** ${cluster.cluster_id ?? 'unknown'}`);
        if (cluster.case_name) lines.push(`  **Case:** ${cluster.case_name}`);
        lines.push(`  **Court:** ${cluster.court ?? 'unresolved'} (${cluster.court_id ?? 'n/a'})`);
        if (cluster.date_filed) lines.push(`  **Filed:** ${cluster.date_filed}`);
        if (cluster.docket_id != null) lines.push(`  **Docket ID:** ${cluster.docket_id}`);
        if (cluster.precedential_status) lines.push(`  **Status:** ${cluster.precedential_status}`);
        if (cluster.cite_count != null) lines.push(`  **Cited by:** ${cluster.cite_count}`);
        if (cluster.judges) lines.push(`  **Judges:** ${cluster.judges}`);
        if (cluster.citations.length > 0) {
          lines.push(`  **All citations:** ${cluster.citations.join(', ')}`);
        }
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
