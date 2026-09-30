/**
 * @fileoverview Characterize declared handler errors on both MCP response surfaces.
 * @module tests/tools/error-recovery-contracts.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCitationsTool } from '@/mcp-server/tools/definitions/get-citations.tool.js';
import { getOpinionTool } from '@/mcp-server/tools/definitions/get-opinion.tool.js';
import { getOralArgumentTool } from '@/mcp-server/tools/definitions/get-oral-argument.tool.js';
import { lookupCitationTool } from '@/mcp-server/tools/definitions/lookup-citation.tool.js';
import { searchDocketsTool } from '@/mcp-server/tools/definitions/search-dockets.tool.js';
import { searchJudgesTool } from '@/mcp-server/tools/definitions/search-judges.tool.js';
import { searchOralArgumentsTool } from '@/mcp-server/tools/definitions/search-oral-arguments.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as service from '@/services/courtlistener/courtlistener-service.js';

afterEach(() => vi.restoreAllMocks());

const cases = [
  {
    definition: lookupCitationTool,
    reason: 'empty_citation',
    run: () => runToolContract(lookupCitationTool, { citation: ' ' }),
  },
  {
    definition: lookupCitationTool,
    reason: 'citation_too_long',
    run: () => runToolContract(lookupCitationTool, { citation: 'x'.repeat(64_001) }),
  },
  {
    definition: searchJudgesTool,
    reason: 'empty_query',
    run: () => runToolContract(searchJudgesTool, { q: ' ' }),
  },
  {
    definition: searchDocketsTool,
    reason: 'empty_query',
    run: () => runToolContract(searchDocketsTool, { q: ' ' }),
  },
  {
    definition: searchDocketsTool,
    reason: 'invalid_date',
    run: () => runToolContract(searchDocketsTool, { q: 'test', filed_after: '2020-02-31' }),
  },
  {
    definition: searchOralArgumentsTool,
    reason: 'empty_query',
    run: () => runToolContract(searchOralArgumentsTool, { q: ' ' }),
  },
  {
    definition: searchOralArgumentsTool,
    reason: 'invalid_date',
    run: () => runToolContract(searchOralArgumentsTool, { q: 'test', argued_after: '2020-02-31' }),
  },
  {
    definition: getCitationsTool,
    reason: 'invalid_date',
    run: () => runToolContract(getCitationsTool, { cluster_id: 1, filed_after: '2020-02-31' }),
  },
  {
    definition: getOralArgumentTool,
    reason: 'unknown_section',
    run: () => runToolContract(getOralArgumentTool, { id: 1, sections: ['missing'] }),
  },
  {
    definition: getOpinionTool,
    reason: 'unknown_section',
    run: () => runToolContract(getOpinionTool, { cluster_id: 1, sections: ['opinion_2'] }),
  },
];

describe('declared handler error recovery', () => {
  it.each(cases)(
    '$definition.name: $reason reaches both surfaces',
    async ({ definition, reason, run }) => {
      const getOpinionCluster = vi.fn().mockResolvedValue({ id: 1, sub_opinions: [] });
      const accessor = vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
        getOpinionCluster,
      } as unknown as CourtListenerService);

      const result = await run();
      const contract = definition.errors!.find((entry) => entry.reason === reason)!;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: contract.code, data: { reason, recovery: { hint: contract.recovery } } },
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining(contract.recovery),
          }),
        ]),
      );
      if (definition === getOpinionTool) {
        expect(getOpinionCluster).toHaveBeenCalledOnce();
      } else {
        expect(accessor).not.toHaveBeenCalled();
      }
    },
  );
});
