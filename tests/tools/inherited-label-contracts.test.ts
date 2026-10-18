/**
 * @fileoverview Court label pass-through on the actual service and both tool surfaces.
 * @module tests/tools/inherited-label-contracts.test
 */

import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDocketTool } from '@/mcp-server/tools/definitions/get-docket.tool.js';
import { getOpinionTool } from '@/mcp-server/tools/definitions/get-opinion.tool.js';
import { lookupCitationTool } from '@/mcp-server/tools/definitions/lookup-citation.tool.js';
import { initCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

describe('inherited court labels', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['constructor', 'constructor'],
    ['__proto__', '\\_\\_proto\\_\\_'],
    ['toString', 'toString'],
  ])(
    'preserves %s through docket, opinion, and citation lookup contracts',
    async (courtId, opinionCourt) => {
      initCourtListenerService(
        {
          apiToken: 'test-token',
          mcpServerVersion: 'test',
          rateLimitPerMinute: 10000,
          rateLimitPerHour: 100000,
        },
        createInMemoryStorage(),
      );
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          const path = new URL(input).pathname;
          const body = path.includes('/citation-lookup/')
            ? [{ citation: '1 U.S. 1', status: 200, clusters: [{ id: 100, docket_id: 200 }] }]
            : path.includes('/dockets/')
              ? { id: 200, court_id: courtId }
              : path.includes('/clusters/')
                ? { id: 100, docket: '/api/rest/v4/dockets/200/' }
                : { count: 0, next: null, results: [] };
          return new Response(JSON.stringify(body));
        }),
      );
      const docket = await runToolContract(getDocketTool, { docket_id: 200 });
      const opinion = await runToolContract(getOpinionTool, { cluster_id: 100 });
      const citation = await runToolContract(lookupCitationTool, { citation: '1 U.S. 1' });
      for (const result of [docket, opinion]) {
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({ court: courtId, court_id: courtId });
        const displayed = result === opinion ? opinionCourt : courtId;
        expect(
          result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
        ).toContain(`**Court:** ${displayed} (${displayed})`);
      }
      expect(citation.isError).not.toBe(true);
      expect(citation.structuredContent).toMatchObject({
        matches: [{ clusters: [{ court: courtId, court_id: courtId }] }],
      });
      expect(JSON.stringify(citation.content)).toContain(
        `**Court:** ${courtId} (${courtId}) [resolved]`,
      );
    },
  );
});
