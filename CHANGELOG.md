# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-06-20

Adopt mcp-ts-core ^0.10.9: new check-dependency-specifiers + plugin-manifest devcheck guards, ctx.content media collector, Canvas SQL classification fixes; resync 14 skills, fill codex plugin longDescription, dependency refresh.

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-06-11

Adopt mcp-ts-core ^0.10.6: server identity pair, get_parties total-count enrichment, Dockerfile healthcheck and writable data dirs, anchored bundle ignores with post-pack cleaner.

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-06-04

Add courtlistener_get_parties tool — fetch parties and attorneys of record for a RECAP federal docket

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-06-02

Adopt @cyanheads/mcp-ts-core 0.9.21 — per-request log context fix, secret-stripped error messages, withRetry fail-fast

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-01

Two new tools (financial disclosures, oral arguments), data-normalization fixes across five tools, machine-readable error contracts

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-30

enrichment adoption — query echoes, true result totals, and empty-result guidance on search/list tools; fixed total_entries and lookup_courts count fields

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-28

@cyanheads/mcp-ts-core ^0.9.9 → ^0.9.13, public hosted endpoint, landing page open by default

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-26

Package metadata, install badges, and scripts migrated to bun run

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-25

Add mcpName field required by MCP Registry; add publish-mcp script

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-25

API response normalization fixes — opinions, dockets, judges, and citations now return correct data from sub-resource fetches

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-25

Initial release — CourtListener MCP server with 10 tools covering opinions, dockets, judges, citation networks, courts, and oral arguments
