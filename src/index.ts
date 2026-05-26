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
import { getJudgeTool } from './mcp-server/tools/definitions/get-judge.tool.js';
import { getOpinionTool } from './mcp-server/tools/definitions/get-opinion.tool.js';
import { lookupCitationTool } from './mcp-server/tools/definitions/lookup-citation.tool.js';
import { lookupCourtsTool } from './mcp-server/tools/definitions/lookup-courts.tool.js';
import { searchDocketsTool } from './mcp-server/tools/definitions/search-dockets.tool.js';
import { searchJudgesTool } from './mcp-server/tools/definitions/search-judges.tool.js';
// Tool definitions
import { searchOpinionsTool } from './mcp-server/tools/definitions/search-opinions.tool.js';
import { searchOralArgumentsTool } from './mcp-server/tools/definitions/search-oral-arguments.tool.js';
import { initCourtListenerService } from './services/courtlistener/courtlistener-service.js';

await createApp({
  tools: [
    searchOpinionsTool,
    getOpinionTool,
    getCitationsTool,
    lookupCitationTool,
    searchDocketsTool,
    getDocketTool,
    searchJudgesTool,
    getJudgeTool,
    lookupCourtsTool,
    searchOralArgumentsTool,
  ],
  resources: [courtsReferenceResource],
  prompts: [legalResearchPrompt],
  instructions:
    'CourtListener MCP server — access 9M+ US court opinions, RECAP federal dockets, judge records, citation networks, and oral arguments.\n' +
    '- Start with courtlistener_lookup_courts to discover court IDs before filtering searches\n' +
    '- Free tier rate limit: 5 req/min, 50/hr, 125/day — keep page_size low and avoid multi-hop workflows that exceed 3–4 calls\n' +
    '- courtlistener_lookup_citation resolves citation strings (e.g., "410 U.S. 113") to cluster IDs\n' +
    '- courtlistener_get_citations traces precedent networks (direction="cited_by" for downstream influence)',
  setup(core) {
    const serverConfig = getServerConfig();
    // Pass server config fields through AppConfig by augmenting it
    const augmentedConfig = Object.assign(Object.create(core.config), {
      apiToken: serverConfig.apiToken,
      baseUrl: serverConfig.baseUrl,
    });
    initCourtListenerService(augmentedConfig, core.storage);
  },
});
