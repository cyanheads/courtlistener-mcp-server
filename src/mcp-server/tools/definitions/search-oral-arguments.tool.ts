/**
 * @fileoverview Search CourtListener appellate oral argument audio recordings.
 * @module mcp-server/tools/definitions/search-oral-arguments.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

export const searchOralArgumentsTool = tool('courtlistener_search_oral_arguments', {
  title: 'Search Oral Arguments',
  description:
    'Search appellate oral argument audio recordings — the largest public collection of oral argument audio. Returns recording metadata with download URLs, panel judge IDs, and transcript snippets where available. Download URLs are direct MP3 links. Panel judge IDs can be passed to courtlistener_get_judge for biographical context.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: false },

  input: z.object({
    q: z
      .string()
      .min(1)
      .describe(
        'Query terms matched against case name and transcribed argument text (where available).',
      ),
    court: z.string().optional().describe('Filter to a specific court (e.g., "scotus", "ca9").'),
    argued_after: z
      .string()
      .optional()
      .describe(
        'Earliest date the case was argued (ISO 8601) — filters by argument date, not publication date.',
      ),
    argued_before: z.string().optional().describe('Latest date the case was argued (ISO 8601).'),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(10)
      .describe('Number of results (1–20).'),
    cursor: z
      .string()
      .optional()
      .describe("Pagination cursor from a previous response's next_cursor field."),
  }),

  output: z.object({
    total_count: z.number().describe('Total matching oral argument recordings.'),
    results: z
      .array(
        z
          .object({
            audio_id: z.number().describe('Audio recording ID.'),
            case_name: z.string().describe('Case name.'),
            court: z.string().describe('Court display name.'),
            court_id: z.string().describe('Court identifier.'),
            date_argued: z
              .string()
              .nullable()
              .describe('Date the case was argued; null if not recorded.'),
            docket_id: z.number().describe('Associated docket ID.'),
            docket_number: z.string().describe('Docket number.'),
            judges: z.string().describe('Judge names on the panel.'),
            panel_ids: z
              .array(z.number())
              .describe('Person IDs of panel judges — pass to courtlistener_get_judge.'),
            duration_seconds: z.number().describe('Recording duration in seconds.'),
            download_url: z
              .string()
              .nullable()
              .describe('Direct MP3 download URL; null if not available.'),
            local_path: z
              .string()
              .nullable()
              .describe('Local storage path on CourtListener servers; null if not available.'),
            snippet: z
              .string()
              .describe('Transcript excerpt where available; empty string if no transcript.'),
          })
          .describe('Oral argument recording.'),
      )
      .describe('Matching oral argument recordings.'),
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
    ctx.log.info('courtlistener_search_oral_arguments', { q: input.q, court: input.court });
    const svc = getCourtListenerService();

    const data = await svc.searchOralArguments(
      {
        q: input.q,
        court: input.court,
        argued_after: input.argued_after,
        argued_before: input.argued_before,
        page_size: input.page_size,
        cursor: input.cursor,
      },
      ctx,
    );

    const results = data.results.map((r) => ({
      audio_id: r.id,
      case_name: r.caseName ?? '',
      court: r.court ?? '',
      court_id: r.court_id ?? '',
      date_argued: r.dateArgued ?? null,
      docket_id: r.docket_id ?? 0,
      docket_number: r.docketNumber ?? '',
      judges: r.judge ?? '',
      panel_ids: r.panel_ids ?? [],
      duration_seconds: r.duration ?? 0,
      download_url: r.download_url ?? null,
      local_path: r.local_path ?? null,
      snippet: r.snippet ?? '',
    }));

    ctx.log.info('courtlistener_search_oral_arguments complete', {
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
      `## CourtListener Oral Arguments`,
      `**Total matching:** ${result.total_count} | **Returned:** ${result.results.length}`,
    ];

    if (result.results.length === 0) {
      lines.push('\n> No oral argument recordings matched the query.');
      return [{ type: 'text', text: lines.join('\n') }];
    }

    for (const r of result.results) {
      const durationMin = Math.floor(r.duration_seconds / 60);
      const durationSec = r.duration_seconds % 60;
      lines.push(`\n### ${r.case_name}`);
      lines.push(
        `**Audio ID:** ${r.audio_id} | **Court:** ${r.court} (${r.court_id}) | **Argued:** ${r.date_argued ?? 'Unknown'}`,
      );
      lines.push(
        `**Docket:** ${r.docket_number} (ID: ${r.docket_id}) | **Duration:** ${durationMin}m ${durationSec}s (${r.duration_seconds}s)`,
      );
      if (r.judges) lines.push(`**Judges:** ${r.judges}`);
      if (r.panel_ids.length > 0) lines.push(`**Panel IDs:** ${r.panel_ids.join(', ')}`);
      if (r.download_url) lines.push(`**Download:** ${r.download_url}`);
      if (r.local_path) lines.push(`**Local path:** ${r.local_path}`);
      if (r.snippet) lines.push(`*${r.snippet}*`);
    }

    if (result.next_cursor) {
      lines.push(`\n**Next page cursor:** \`${result.next_cursor}\``);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
