/**
 * @fileoverview Tests for the server-specific env schema — in particular the
 * rate-limit window defaults the pacer is built from, which are a documented
 * contract (`.env.example`, the README config table) and not an implementation
 * detail.
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Re-imports the module so the memoized config is re-parsed against the stubbed env. */
async function loadConfig() {
  vi.resetModules();
  const mod = await import('@/config/server-config.js');
  return mod.getServerConfig();
}

describe('getServerConfig', () => {
  beforeEach(() => {
    vi.stubEnv('COURTLISTENER_API_TOKEN', 'test-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults the rate-limit windows to the published free tier', async () => {
    const config = await loadConfig();
    expect(config.rateLimitPerMinute).toBe(5);
    expect(config.rateLimitPerHour).toBe(50);
  });

  it('coerces the windows from their env vars, since a token tier can be higher', async () => {
    vi.stubEnv('COURTLISTENER_RATE_LIMIT_PER_MINUTE', '60');
    vi.stubEnv('COURTLISTENER_RATE_LIMIT_PER_HOUR', '5000');

    const config = await loadConfig();
    expect(config.rateLimitPerMinute).toBe(60);
    expect(config.rateLimitPerHour).toBe(5000);
  });

  it('rejects a window that cannot pace anything', async () => {
    vi.stubEnv('COURTLISTENER_RATE_LIMIT_PER_MINUTE', '0');
    await expect(loadConfig()).rejects.toThrow(/COURTLISTENER_RATE_LIMIT_PER_MINUTE/);
  });

  it('rejects a non-numeric window rather than pacing on NaN', async () => {
    vi.stubEnv('COURTLISTENER_RATE_LIMIT_PER_HOUR', 'plenty');
    await expect(loadConfig()).rejects.toThrow(/COURTLISTENER_RATE_LIMIT_PER_HOUR/);
  });

  it('takes the defaults when the env vars are set but blank', async () => {
    // What an MCPB or plugin host forwards for an option the user left empty.
    vi.stubEnv('COURTLISTENER_RATE_LIMIT_PER_MINUTE', '');
    vi.stubEnv('COURTLISTENER_RATE_LIMIT_PER_HOUR', '');

    const config = await loadConfig();
    expect(config.rateLimitPerMinute).toBe(5);
    expect(config.rateLimitPerHour).toBe(50);
  });
});
