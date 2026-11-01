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
import {
  disposeCourtListenerService,
  initCourtListenerService,
} from './services/courtlistener/courtlistener-service.js';

await createApp({
  name: 'courtlistener-mcp-server',
  title: 'courtlistener-mcp-server',
  // No handler calls ctx.requestInput, so nothing needs a session to answer a
  // mid-call prompt. Declared here rather than left to MCP_SESSION_MODE, which
  // still wins in a deployment that sets it.
  sessionMode: 'stateless',
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
  skills: 'skills',
  prompts: [legalResearchPrompt],
  landing: { requireAuth: false },
  instructions:
    'Search US opinions, RECAP federal dockets, judges, citations, oral arguments, and disclosures. Resolve unfamiliar court IDs with courtlistener_lookup_courts; opinion search and courtlistener_lookup_citation return cluster IDs for courtlistener_get_opinion and courtlistener_get_citations, distinct from individual opinion IDs. Read the relevant variants before interpreting citation treatment, and check source completeness separately from retrieval continuation. CourtListener requires an API token; published free-tier limits are 5 requests/minute, 50/hour, and 125/day, with limits varying by token tier. The server queues requests within its minute/hour budgets; honor Retry-After on rate-limit errors. The courtlistener-guide skill covers identifier chains and research gates.',
  setup(core) {
    initCourtListenerService(
      { ...getServerConfig(), mcpServerVersion: core.config.mcpServerVersion },
      core.storage,
    );
  },
  // The service holds a request queue with its own dispatch timer. Close it here so
  // shutdown rejects whatever is still waiting instead of dropping the handle.
  teardown() {
    disposeCourtListenerService();
  },
});
