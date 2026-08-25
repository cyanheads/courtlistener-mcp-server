# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.7.1](changelog/0.7.x/0.7.1.md) — 2026-08-24

The framework bump to mcp-ts-core ^0.12.3 tightens the wire: tool inputs reject undeclared argument keys, the advertised outputSchema declares the error envelope, schemas emit as JSON Schema 2020-12, and the HTTP endpoint serves protocol revision 2026-07-28 alongside the 2025 revisions.

## [0.7.0](changelog/0.7.x/0.7.0.md) — 2026-07-30 · ⚠️ Breaking

courtlistener_lookup_courts's jurisdiction filter now mirrors CourtListener's own Court.JURISDICTIONS choices exactly, in place of the drifted 15-code enum.

## [0.6.1](changelog/0.6.x/0.6.1.md) — 2026-07-30

courtlistener_get_judge walks the full paginated position history instead of a fixed 50-row fetch; courtlistener_lookup_citation gets a caller-controlled court-backfill budget; courtlistener_lookup_courts can now enumerate every court, active or historical, via a bundled full snapshot.

## [0.6.0](changelog/0.6.x/0.6.0.md) — 2026-07-30 · ⚠️ Breaking

courtlistener_lookup_courts, courtlistener_lookup_citation, and courtlistener_get_parties get breaking contract changes to reach data the old shapes couldn't; courtlistener_get_oral_argument's outline response stops dropping record metadata.

## [0.5.3](changelog/0.5.x/0.5.3.md) — 2026-07-30

courtlistener_get_judge and courtlistener_get_opinion decode coded fields (position_type, termination_reason, degree, opinion type) to labels alongside the raw codes, get_judge gains date-granularity fields so year/month-only dates stop rendering as YYYY-01-01, education[].year is fixed, and blank-able fields report null instead of empty strings.

## [0.5.2](changelog/0.5.x/0.5.2.md) — 2026-07-29

courtlistener_get_citations \"cited_by\" now resolves the cluster's opinion IDs before querying the cites index (it previously matched nothing when the cluster and opinion IDs diverge), getOpinionCluster walks sub-opinion pagination to completion, and \"citing\" empty pages under filters are distinguished from an exhausted network.

## [0.5.1](changelog/0.5.x/0.5.1.md) — 2026-07-29

courtlistener_get_parties now scopes attorneys to the requested docket and resolves their names/contact through a docket-filtered cursor walk instead of a broken batch lookup; role_code decodes correctly and the upstream Retry-After now reaches rate-limit errors.

## [0.5.0](changelog/0.5.x/0.5.0.md) — 2026-07-29 · ⚠️ Breaking

search_dockets, search_opinions/get_citations, and search_judges now parse the v4 /search/ response shapes instead of keys the API never returns — document_count is removed, snippet nests under opinions[], current_position derives from positions[]; local_path/filepath_local resolve to fetchable storage URLs; mcp-ts-core 0.11.0.

## [0.4.3](changelog/0.4.x/0.4.3.md) — 2026-07-16

courtlistener_get_oral_argument rejects an unknown `sections` name before fetching the oral-argument record, instead of fetching first and rejecting after.

## [0.4.2](changelog/0.4.x/0.4.2.md) — 2026-07-16

courtlistener_lookup_courts pages through all ~472 courts instead of returning only the first 20; courtlistener_search_financial_disclosures and courtlistener_get_citations no longer drop next_cursor from content[] on an empty page.

## [0.4.1](changelog/0.4.x/0.4.1.md) — 2026-07-15

courtlistener_get_opinion/get_oral_argument reject unknown sections names and render the full/outline response mode in content[]; search and citation tools reject blank queries and malformed date filters before spending a rate-limited request.

## [0.4.0](changelog/0.4.x/0.4.0.md) — 2026-07-10

Adds courtlistener_get_financial_disclosure for itemized financial-disclosure line items (investments, debts, positions, income, gifts) with coded AO values decoded to dollar ranges; ships the previously-missing Apache-2.0 LICENSE file.

## [0.3.1](changelog/0.3.x/0.3.1.md) — 2026-07-10

get_docket exposes retrievable docket-entry pagination via a new entries_page input and next_cursor continuation; get_citations and search_financial_disclosures page_size descriptions now document CourtListener's 20-result minimum.

## [0.3.0](changelog/0.3.x/0.3.0.md) — 2026-07-10 · ⚠️ Breaking

get_opinion and get_oral_argument adopt honest outline-on-overflow (breaking): large opinion/transcript text returns a re-callable outline instead of truncating in content[]. Also fixes get_oral_argument panel_ids validation failures. mcp-ts-core bumped to 0.10.14 plus Socket supply-chain scanning.

## [0.2.6](changelog/0.2.x/0.2.6.md) — 2026-06-30 · 🛡️ Security

Three CourtListener display fixes plus a security framework bump. get_opinion surfaces text from all HTML/XML variant fields (pre-2000 opinions no longer empty), court names resolve for all 471 in-use courts, get_judge expands how_selected codes to readable labels. mcp-ts-core 0.10.10 clears hono, js-yaml, and vite advisories.

## [0.2.5](changelog/0.2.x/0.2.5.md) — 2026-06-30

Six live-API bug fixes: get_parties output validation, page-based next_cursor, and party-role resolution; get_docket string document_number and fully-qualified filepath_local; get_citations citing-direction pagination; 429 fail-fast. Output-contract shifts are patch-safe — the fields failed validation before.

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
