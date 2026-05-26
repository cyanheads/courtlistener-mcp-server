<div align="center">
  <h1>@cyanheads/courtlistener-mcp-server</h1>
  <p><b>Search and retrieve US court opinions, federal dockets, judge records, citation networks, and oral arguments from CourtListener's 9M+ opinion corpus via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

10 tools spanning the full CourtListener dataset — opinion search and retrieval, citation network traversal, federal docket lookup, judge biography, court discovery, and oral argument search:

| Tool | Description |
|:---|:---|
| `courtlistener_search_opinions` | Full-text search across 9M+ written court opinions with field-level filtering, date ranges, status, and sort |
| `courtlistener_get_opinion` | Fetch full text and metadata for an opinion cluster — returns all opinion variants (majority, concurrence, dissent) |
| `courtlistener_get_citations` | Retrieve the citation network for an opinion: opinions cited by it (`citing`) or that cite it (`cited_by`) |
| `courtlistener_lookup_citation` | Resolve a legal citation string (e.g., "410 U.S. 113") to a cluster ID and case metadata |
| `courtlistener_search_dockets` | Search RECAP federal court dockets by party name, attorney, court, and date |
| `courtlistener_get_docket` | Fetch docket metadata and entry list for a single federal case |
| `courtlistener_search_judges` | Search judge records by name, appointing president, court, and political affiliation |
| `courtlistener_get_judge` | Fetch full biographical profile, appointment history, and education for a single judge |
| `courtlistener_lookup_courts` | List courts filtered by jurisdiction type and active-scraper status |
| `courtlistener_search_oral_arguments` | Search appellate oral argument audio recordings by case name, court, and date argued |

### `courtlistener_search_opinions`

Search the 9M+ opinion corpus. Returns opinion cluster summaries with matched text excerpts.

- Free-text queries with field syntax: `caseName:`, `court_id:`, `judge:`, `docketNumber:`, `cites:(id)`, boolean `AND / OR / NOT`
- Filter by court ID, date range, publication status (Published / Unpublished / In-chambers, etc.)
- Sort by relevance score, filing date (asc/desc), or citation count
- Cursor-based pagination; up to 20 results per call
- Results include `cluster_id` (for `courtlistener_get_opinion`) and `docket_id` (for `courtlistener_get_docket`) for chaining

---

### `courtlistener_get_opinion`

Fetch full text and metadata for an opinion cluster.

- A cluster groups all opinions filed in a case: majority, concurrence, dissent, per curiam
- Returns `html_text` and `plain_text` for each opinion variant; surfaces `download_url` when local text is absent
- Includes `cites[]` (outbound citation IDs), `cite_count`, syllabus, posture, and docket link
- Single upstream request — safe within the tight free-tier rate limit

---

### `courtlistener_get_citations`

Retrieve the citation network for an opinion cluster in either direction.

- `cited_by` (default): opinions that cite this one — measures precedential influence and downstream adoption
- `citing`: opinions this one cites — reveals the authority chain the court relied on
- Optional court and date filters; cursor-based pagination; up to 20 results per call
- Results include `snippet` showing the excerpt around the citation reference
- Rate-limit note: the free tier (125 req/day) supports 1–2 hops on a single case; deep multi-hop traversal exhausts the daily budget quickly

---

### `courtlistener_lookup_citation`

Resolve a formatted legal citation string to a cluster ID.

- Accepts standard reporter formats: "410 U.S. 113", "347 U.S. 483", "93 S. Ct. 705"
- Returns cluster ID, case name, court, date filed, all known citation strings, and the canonical form CourtListener uses
- Single upstream POST to `/citation-lookup/`; falls back to search when unauthenticated

---

### `courtlistener_search_dockets`

Search RECAP federal court dockets.

- Query matched against case name, docket number, party names, and attorney names
- `party_name` filter applies in addition to (AND with) the `q` query — more precise than embedding party names in the query
- Returns up to 3 sample document entries per docket with `is_available` status
- `coverage_note` in every response — RECAP is crowd-sourced from PACER; completeness varies by court

---

### `courtlistener_get_docket`

Fetch full docket metadata and entry list for a single federal case.

- Returns all available docket entries with document availability, page count, and RECAP file path
- `entries_page_size` controls how many entries are returned (1–50); large cases have hundreds
- Documents with `is_available: false` require a PACER account or CourtListener RECAP filing — document retrieval is not exposed

---

### `courtlistener_search_judges`

Search judge and person records across the federal and state bench.

- Filter by appointing president's last name, court ID, or political affiliation (`d/r/i/l/g/u`)
- Returns `person_id` for chaining to `courtlistener_get_judge`, plus current position summary
- Court IDs from `courtlistener_lookup_courts` can be passed directly

---

### `courtlistener_get_judge`

Fetch a judge's full biographical profile.

- Complete appointment history: all courts served, position type, appointer, nomination date, confirmation date, termination reason
- Education records with school, degree, and year
- Political affiliations with date ranges; ABA ratings; Federal Judicial Center ID for cross-referencing

---

### `courtlistener_lookup_courts`

List courts with optional jurisdiction and scraper filters.

- Jurisdiction codes cover federal appellate (`F`), district (`FD`), bankruptcy (`FB`), state supreme (`SS`), state appellate (`SA`), tribal, and more
- `in_use: true` (default) restricts to courts currently scraped by CourtListener
- `has_opinion_scraper` filter useful for planning opinion searches — courts without scrapers have sparse coverage
- Returns `id` (the `court_id` string for use in all search and filter parameters), citation string (e.g., "9th Cir."), and jurisdiction label

---

### `courtlistener_search_oral_arguments`

Search appellate oral argument audio recordings — the largest public collection of oral argument audio.

- Query matched against case name and transcribed argument text (where available)
- Filters by court, argued-after, and argued-before date
- Returns `download_url` (MP3), `duration_seconds`, `panel_ids` (chaining to `courtlistener_get_judge`), and transcript `snippet`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling across all tools
- Pluggable auth (`none`, `jwt`, `oauth`)
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

CourtListener-specific:

- Complete CourtListener REST API v4 integration — opinions, dockets, judges, courts, oral arguments, citation network
- Rate-limit-aware client: 429 responses classified by window (minute / hour / day) with actionable error messages; retry with Retry-After respect
- Cursor-based pagination throughout — consistent results across all paginated endpoints
- RECAP coverage note surfaced on every docket response — sets expectations on partial PACER mirror completeness
- No workflow tool exceeds 2 upstream calls per invocation, keeping the free tier (125 req/day) usable for multi-step research

Agent-friendly output:

- Chaining IDs on every response — `cluster_id`, `docket_id`, and `person_id` fields are present wherever they enable a logical follow-up call, with field-level descriptions naming which tool to pass them to
- Discriminated rate-limit errors — minute / hour / day throttle identified in structured error so agents can reason about retry timing, not just "try again later"
- Coverage caveats inline — RECAP `coverage_note` and oral argument transcript `snippet` availability explicitly signaled so agents can communicate limitations to users rather than silently omitting them

## Getting started

Add the following to your MCP client configuration file. See [CourtListener account settings](https://www.courtlistener.com/profile/settings/) to generate a free API token.

```json
{
  "mcpServers": {
    "courtlistener": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/courtlistener-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "COURTLISTENER_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "courtlistener": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/courtlistener-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "COURTLISTENER_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "courtlistener": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "COURTLISTENER_API_TOKEN=your-api-token",
        "ghcr.io/cyanheads/courtlistener-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 COURTLISTENER_API_TOKEN=... bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v24+).
- A CourtListener API token — free account at [courtlistener.com](https://www.courtlistener.com/sign-in/). Free tier: 5 req/min, 50 req/hr, 125 req/day. [Free Law Project membership](https://free.law/donate/) unlocks higher limits.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/courtlistener-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd courtlistener-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env and set COURTLISTENER_API_TOKEN
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---------|:------------|:--------|
| `COURTLISTENER_API_TOKEN` | **Required.** API token from your CourtListener account settings. Free tier: 5 req/min, 50/hr, 125/day. | — |
| `COURTLISTENER_BASE_URL` | API base URL override. | `https://www.courtlistener.com/api/rest/v4` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path. | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin for TLS-terminating reverse-proxy deployments. | — |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop (ms). Try `60000` if RSS grows under sustained HTTP load. | `0` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t courtlistener-mcp-server .
docker run --rm -e COURTLISTENER_API_TOKEN=your-token -p 3010:3010 courtlistener-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/courtlistener-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Ten tools across opinions, dockets, judges, courts, and oral arguments. |
| `src/services/courtlistener` | CourtListener REST API client — auth, retry, rate-limit error classification. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrels in `src/mcp-server/tools/definitions/index.ts`
- Wrap CourtListener API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
