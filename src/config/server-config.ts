/**
 * @fileoverview Server-specific environment variable configuration.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  apiToken: z.string().min(1).describe('CourtListener API token from account settings'),
  baseUrl: z
    .string()
    .url()
    .default('https://www.courtlistener.com/api/rest/v4')
    .describe('CourtListener API base URL'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    apiToken: 'COURTLISTENER_API_TOKEN',
    baseUrl: 'COURTLISTENER_BASE_URL',
  });
  return _config;
}
