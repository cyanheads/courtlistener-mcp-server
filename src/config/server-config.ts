/**
 * @fileoverview Server-specific environment variable configuration.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

/**
 * Rate-limit defaults track CourtListener's published free tier (5 req/min,
 * 50/hour). Actual limits vary by token tier, so both are overridable rather than
 * pinned — a paid tier that leaves them at the free-tier numbers would queue
 * requests it is entitled to send.
 */
const ServerConfigSchema = z.object({
  apiToken: z.string().min(1).describe('CourtListener API token from account settings'),
  baseUrl: z
    .string()
    .url()
    .default('https://www.courtlistener.com/api/rest/v4')
    .describe('CourtListener API base URL'),
  rateLimitPerHour: z.coerce
    .number()
    .int()
    .positive()
    .default(50)
    .describe('Requests this server will start against CourtListener within a rolling hour'),
  rateLimitPerMinute: z.coerce
    .number()
    .int()
    .positive()
    .default(5)
    .describe('Requests this server will start against CourtListener within a rolling minute'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiToken: 'COURTLISTENER_API_TOKEN',
    baseUrl: 'COURTLISTENER_BASE_URL',
    rateLimitPerHour: 'COURTLISTENER_RATE_LIMIT_PER_HOUR',
    rateLimitPerMinute: 'COURTLISTENER_RATE_LIMIT_PER_MINUTE',
  });
  return _config;
}
