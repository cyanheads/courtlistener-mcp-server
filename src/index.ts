#!/usr/bin/env node
/**
 * @fileoverview courtlistener-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
// Prompt definitions
import { legalResearchPrompt } from './mcp-server/prompts/definitions/legal-research.prompt.js';
// Resource definitions
import { courtsReferenceResource } from './mcp-server/resources/definitions/courts-reference.resource.js';
import { getCitationsTool } from './mcp-server/tools/definitions/get-citations.tool.js';
import { getDocketTool } from './mcp-server/tools/definitions/get-docket.tool.js';
import { getFinancialDisclosureTool } from './mcp-server/tools/definitions/get-financial-disclosure.tool.js';
import { getJudgeTool } from './mcp-server/tools/definitions/get-judge.tool.js';
import { getOpinionTool } from './mcp-server/tools/definitions/get-opinion.tool.js';
import { getOralArgumentTool } from './mcp-server/tools/definitions/get-oral-argument.tool.js';
import { getPartiesTool } from './mcp-server/tools/definitions/get-parties.tool.js';
import { lookupCitationTool } from './mcp-server/tools/definitions/lookup-citation.tool.js';
import { lookupCourtsTool } from './mcp-server/tools/definitions/lookup-courts.tool.js';
import { searchDocketsTool } from './mcp-server/tools/definitions/search-dockets.tool.js';
import { searchFinancialDisclosuresTool } from './mcp-server/tools/definitions/search-financial-disclosures.tool.js';
import { searchJudgesTool } from './mcp-server/tools/definitions/search-judges.tool.js';
// Tool definitions
import { searchOpinionsTool } from './mcp-server/tools/definitions/search-opinions.tool.js';
import { searchOralArgumentsTool } from './mcp-server/tools/definitions/search-oral-arguments.tool.js';
import { initCourtListenerService } from './services/courtlistener/courtlistener-service.js';

await createApp({
  name: 'courtlistener-mcp-server',
  title: 'courtlistener-mcp-server',
  tools: [
    searchOpinionsTool,
    getOpinionTool,
    getCitationsTool,
    lookupCitationTool,
    searchDocketsTool,
    getDocketTool,
    getPartiesTool,
    searchJudgesTool,
    getJudgeTool,
    lookupCourtsTool,
    searchOralArgumentsTool,
    getOralArgumentTool,
    searchFinancialDisclosuresTool,
    getFinancialDisclosureTool,
  ],
  resources: [courtsReferenceResource],
  prompts: [legalResearchPrompt],
  landing: { requireAuth: false },
  instructions:
    'CourtListener MCP server — access 9M+ US court opinions, RECAP federal dockets, judge records, citation networks, and oral arguments.\n' +
    '- Start with courtlistener_lookup_courts to discover court IDs before filtering searches\n' +
    '- CourtListener publishes free-tier limits of 5 req/min, 50/hr, 125/day, but actual limits vary by token tier — pace multi-hop workflows and honor the Retry-After returned on a 429\n' +
    '- courtlistener_lookup_citation resolves citation strings (e.g., "410 U.S. 113") to cluster IDs\n' +
    '- courtlistener_get_citations traces precedent networks (direction="cited_by" for downstream influence)',
  setup(core) {
    initCourtListenerService(
      { ...getServerConfig(), mcpServerVersion: core.config.mcpServerVersion },
      core.storage,
    );
  },
});
