<div align="center">
  <h1>@cyanheads/courtlistener-mcp-server</h1>
  <p><b>Search and retrieve US court opinions, federal dockets, judge records, citation networks, and oral arguments from CourtListener's 9M+ opinion corpus via MCP. STDIO or Streamable HTTP.</b>
  <div>14 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.6.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/courtlistener-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/courtlistener-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/courtlistener-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/courtlistener-mcp-server/releases/latest/download/courtlistener-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=courtlistener-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY291cnRsaXN0ZW5lci1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22courtlistener-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcourtlistener-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://courtlistener.caseyjhand.com/mcp](https://courtlistener.caseyjhand.com/mcp)

</div>

---

## Tools

14 tools spanning the full CourtListener dataset — opinion search and retrieval, citation network traversal, federal docket lookup, party and attorney lookup, judge biography, judicial financial disclosure search and detail, court discovery, and oral argument search and detail:

| Tool | Description |
|:---|:---|
| `courtlistener_search_opinions` | Full-text search across 9M+ written court opinions with field-level filtering, date ranges, status, and sort |
| `courtlistener_get_opinion` | Fetch full text and metadata for an opinion cluster — returns all opinion variants (majority, concurrence, dissent) |
| `courtlistener_get_citations` | Retrieve the citation network for an opinion: opinions cited by it (`citing`) or that cite it (`cited_by`) |
| `courtlistener_lookup_citation` | Resolve legal citations (e.g., "410 U.S. 113") to cluster IDs and case metadata — one entry per citation found in the input |
| `courtlistener_search_dockets` | Search RECAP federal court dockets by party name, attorney, court, and date |
| `courtlistener_get_docket` | Fetch docket metadata and entry list for a single federal case |
| `courtlistener_get_parties` | Fetch all parties and attorneys of record for a RECAP federal docket by docket ID |
| `courtlistener_search_judges` | Search judge records by name, appointing president, court, and political affiliation |
| `courtlistener_get_judge` | Fetch full biographical profile, appointment history, and education for a single judge |
| `courtlistener_lookup_courts` | List courts filtered by jurisdiction type, active/inactive status, and scraper coverage |
| `courtlistener_search_oral_arguments` | Search appellate oral argument audio recordings by case name, court, and date argued |
| `courtlistener_get_oral_argument` | Fetch full detail for a single oral argument — panel, duration, MP3 link, and speech-to-text transcript |
| `courtlistener_search_financial_disclosures` | Search federal judicial financial disclosure filings by judge and year — category counts, itemized gifts, and source PDF |
| `courtlistener_get_financial_disclosure` | Fetch one disclosure's parsed line items — investments, debts, positions, income, gifts — with coded values decoded to dollar ranges; selectable by category |

### `courtlistener_search_opinions`

Search the 9M+ opinion corpus. Returns opinion cluster summaries with matched text excerpts.

- Free-text queries with field syntax: `caseName:`, `court_id:`, `judge:`, `docketNumber:`, `cites:(id)`, boolean `AND / OR / NOT`
- Filter by court ID, date range, publication status (Published / Unpublished / In-chambers, etc.)
- Sort by relevance score, filing date (asc/desc), or citation count
- Cursor-based pagination; up to 20 results per call
- Results include `cluster_id` (for `courtlistener_get_opinion`) and `docket_id` (for `courtlistener_get_docket`) for chaining
- Each cluster carries its `opinions[]` variants — per-variant opinion ID, type, author, outbound cites, and a CourtListener-hosted `local_path` copy of the source document
- `snippet` is the matched excerpt from the first variant that carries one; CourtListener does not mark which variant the search matched

---

### `courtlistener_get_opinion`

Fetch full text and metadata for an opinion cluster.

- A cluster groups all opinions filed in a case: majority, concurrence, dissent, per curiam
- Returns `html_text` and `plain_text` for each opinion variant; surfaces `download_url` when local text is absent
- Each variant carries `type_label` — the same value `courtlistener_search_opinions` reports (`lead-opinion`, `concurrence-opinion`, `dissent`) — beside the stored `type` code, whose numeric prefix is a sort key
- Includes `cites[]` (outbound citation IDs), `cite_count`, syllabus, posture, and docket link
- Three upstream requests — the cluster, its opinion variants, and the linked docket for court and docket number — kept within the tight free-tier rate limit

---

### `courtlistener_get_citations`

Retrieve the citation network for an opinion cluster in either direction.

- `cited_by` (default): opinions that cite this one — measures precedential influence and downstream adoption
- `citing`: opinions this one cites — reveals the authority chain the court relied on
- Optional court and date filters; up to 20 results per call
- Pagination differs by direction: `cited_by` follows CourtListener's own cursor with the filters applied, so its total and its pages describe the same set; `citing` walks the cited-opinion list and filters each page as it goes, so a filtered page can come back empty with matches still ahead — the response distinguishes that from an exhausted network
- Results include `snippet`, the matched excerpt from the related opinion — a relevance preview for the cluster, not necessarily the text surrounding the citation
- Rate-limit note: three upstream requests per call in either direction; the free tier supports 1–2 hops on a single case, and deep multi-hop traversal exhausts the daily budget quickly

---

### `courtlistener_lookup_citation`

Resolve legal citations to opinion cluster IDs.

- Accepts standard reporter formats: "410 U.S. 113", "347 U.S. 483", "93 S. Ct. 705"
- Returns `matches`, one entry per citation CourtListener extracted from the input — pass a passage and every citation in it resolves, each with its own `status` (200 one case, 300 several candidates, 400 unrecognized reporter, 404 no match) and decoded `status_label`
- Each match carries the cases it resolved to: `cluster_id`, `case_name`, `court` / `court_id`, `court_resolution`, `docket_id`, `date_filed`, all known citation strings, `cite_count`, `precedential_status`, and `judges`
- An unresolved or ambiguous citation comes back inside `matches`, not as an error — only text carrying no parseable citation at all fails
- `court` is absent from the citation-lookup payload (the court lives on the linked docket), so it is resolved from `docket_id` — one extra request per distinct docket, bounded by `max_court_lookups` (default 4, up to 20; 0 skips court resolution). `court_resolution` (`resolved` / `no_docket` / `lookup_failed` / `over_budget`) says why a court is or isn't populated — only `over_budget` is worth retrying with a larger budget
- One upstream POST to `/citation-lookup/` plus those court lookups, issued sequentially and stopped early on the first rate-limited response. The endpoint requires authentication and has no unauthenticated path

---

### `courtlistener_search_dockets`

Search RECAP federal court dockets.

- Query matched against case name, docket number, party names, and attorney names
- `party_name` filter applies in addition to (AND with) the `q` query — more precise than embedding party names in the query
- Returns the docket's `parties`, `attorneys`, and `firms`, plus nature of suit, jurisdiction type, and the referred magistrate judge
- Returns up to 3 sample document entries per docket — a search excerpt, not the full filing list — each with `is_available` status, page count, and a fully-qualified RECAP storage URL when a copy is stored
- `coverage_note` in every response — RECAP is crowd-sourced from PACER; completeness varies by court

---

### `courtlistener_get_docket`

Fetch full docket metadata and entry list for a single federal case.

- Returns all available docket entries with document availability, page count, and RECAP file path
- `entries_page_size` controls how many entries are returned (1–50); large cases have hundreds
- Documents with `is_available: false` require a PACER account or CourtListener RECAP filing — document retrieval is not exposed

---

### `courtlistener_get_parties`

Fetch all parties and attorneys of record for a RECAP federal docket.

- Returns each party's name, docket-scoped role (Plaintiff, Defendant, Petitioner, Respondent, etc.), and the attorneys of record on this docket with contact information
- Attorney roles are decoded to labels (`Lead attorney`, `Terminated`, …) alongside the raw code, with the date a relationship ended
- Attorney names and contact details are resolved from the docket's attorney roster — 2 upstream requests per invocation, plus one for each extra roster page on a docket with a large attorney list
- Paginate large party lists by passing a response's `next_cursor` back as `cursor` — this endpoint is cursor-paginated, so there is no page number to increment; `page_size` (max 10) is a request only, and CourtListener paginates at a fixed size that can return more parties than asked for
- Obtain docket IDs from `courtlistener_search_dockets` or `courtlistener_get_docket`

---

### `courtlistener_search_judges`

Search judge and person records across the federal and state bench.

- Filter by appointing president's last name, court ID, or political affiliation (`d/r/i/l/g/u`)
- Returns `person_id` for chaining to `courtlistener_get_judge`, plus a `current_position` summary — court, position type, appointer, selection method, and start date — selected as the position with no termination date, or the latest-starting one when several or none qualify
- Political affiliations and ABA ratings come back as expanded labels ("Democratic", "Well Qualified"), not the codes the `political_affiliation` filter takes
- Court IDs from `courtlistener_lookup_courts` can be passed directly

---

### `courtlistener_get_judge`

Fetch a judge's full biographical profile.

- Position history: all courts served, position type, appointer, nomination date, confirmation date, termination reason — plus non-judicial roles, which carry no court and describe themselves in `job_title` and `organization_name`. `/positions/` is cursor-walked under a page bound; a `truncated` notice and `positionsShown`/`truncated` fields report when a long career ran past it
- Position type, termination reason, and degree level come back decoded (`position_type_label`, `termination_reason_label`, `degree_label`) alongside the raw codes CourtListener's own filters take
- Birth, death, and position dates carry the precision CourtListener recorded — `dob_granularity` and the per-position `date_start_granularity` read `year`, `month`, or `day`, and a year-only record renders as the year rather than the stored `YYYY-01-01` placeholder
- Education records with school, degree, and year
- Political affiliations with date ranges; ABA ratings; Federal Judicial Center ID for cross-referencing

---

### `courtlistener_lookup_courts`

List courts with optional jurisdiction and scraper filters.

- Jurisdiction codes cover federal appellate (`F`), district (`FD`), bankruptcy (`FB`), state supreme (`SS`), state appellate (`SA`), tribal, and more
- `status` selects which bench to return: `active` (the default) only the courts CourtListener still scrapes, `inactive` only the historical and defunct ones, `any` both. Upstream filters these as disjoint sets, so `any` is the only value that reaches the whole list
- `has_opinion_scraper` filter useful for planning opinion searches — courts without scrapers have sparse coverage
- Returns `id` (the `court_id` string for use in all search and filter parameters), citation string (e.g., "9th Cir."), and jurisdiction label
- Page-number paginated at a **fixed 20 rows per page** — `/courts/` ignores any requested page size, so there is no way to pull a larger page. Enumerating a whole bench costs one call per 20 courts against a rate-limited free tier, and the inactive bench is several times larger than the active one: `status: 'any'` makes the full set reachable, not cheap. Filter by `jurisdiction` to answer a question in one call; pass a response's `next_cursor` back as `page` when you genuinely need to walk
- `all_matching_court_ids` returns the complete filtered id set from a bundled snapshot of every CourtListener court, at no request cost — covers the default bench and every jurisdiction filter. Empty (not a truncated prefix) when more than 1,000 courts match; check `all_matching_court_ids_complete` before reading emptiness as "no courts match". The live `courts` page stays authoritative for full records

---

### `courtlistener_search_oral_arguments`

Search appellate oral argument audio recordings — the largest public collection of oral argument audio.

- Query matched against case name and transcribed argument text (where available)
- Filters by court, argued-after, and argued-before date
- Returns two MP3 links per recording — `download_url` at the originating court, and `local_path`, CourtListener's durable hosted copy — plus `duration_seconds`, `panel_ids` (chaining to `courtlistener_get_judge`), and transcript `snippet`

---

### `courtlistener_get_oral_argument`

Fetch the full detail record for a single oral argument by audio ID.

- Returns the speech-to-text `transcript` when transcription has completed, plus `panel_ids`, `duration_seconds`, MP3 `download_url`, and the linked `docket_id`
- Audio IDs come from `courtlistener_search_oral_arguments` results
- The argument date is not on this record — take it from the search result or the linked docket

---

### `courtlistener_search_financial_disclosures`

Search federal judicial financial disclosure filings for ethics and recusal research.

- Filter by `judge_id` (a `person_id` from `courtlistener_search_judges`) and/or filing `year`
- The `year` filter is applied to the fetched page only — CourtListener has no server-side year filter, so filings for that year on later pages are not included; page through with `cursor` (the response returns `next_cursor` even when the current page has no year match)
- Returns per-filing category counts (investments, gifts, debts, positions, reimbursements, income), itemized gifts, and a link to the source PDF
- Line-item investments — often hundreds per filing, with coded values — are summarized as counts; the linked PDF carries the full itemization

---

### `courtlistener_get_financial_disclosure`

Fetch one disclosure's parsed line items in full — the itemized companion to the search tool.

- Keyed by `disclosure_id` (from a `courtlistener_search_financial_disclosures` result); one upstream call returns every category inline
- Returns filing metadata, per-category counts, and the requested line-item rows — investments, debts, positions, reimbursements, non-investment and spouse income, agreements, and gifts
- Coded income/value columns are decoded to readable dollar ranges (e.g. `N` → `$250,001 - $500,000`)
- Pass `categories: [...]` to select specific categories; omit for all. When the full itemization is too large to inline, the response returns an outline of categories by size — re-call with `categories: [...]` to pull specific ones in full

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
- Pagination matched to each endpoint's own paginator — cursor-based on the `/search/`-backed tools and on parties/attorneys, page-number on the courts and docket-entry lists — with continuation surfaced on every response
- RECAP coverage note surfaced on every docket response — sets expectations on partial PACER mirror completeness
- Tight upstream-call budget — most tools make 1–2 calls; opinion detail and citation traversal make three (resolving the linked docket, or the source cluster's opinion variants), plus one per extra page of variants on a case that filed many. Citation lookup is the ceiling at five, resolving up to four distinct dockets for their courts

Agent-friendly output:

- Chaining IDs on every response — `cluster_id`, `docket_id`, and `person_id` fields are present wherever they enable a logical follow-up call, with field-level descriptions naming which tool to pass them to
- Discriminated rate-limit errors — minute / hour / day throttle identified in structured error so agents can reason about retry timing, not just "try again later"
- Coverage caveats inline — RECAP `coverage_note` and oral argument transcript `snippet` availability explicitly signaled so agents can communicate limitations to users rather than silently omitting them

## Getting started

### Public Hosted Instance

A public instance is available at `https://courtlistener.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "courtlistener-mcp-server": {
      "type": "streamable-http",
      "url": "https://courtlistener.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. See [CourtListener account settings](https://www.courtlistener.com/profile/settings/) to generate a free API token.

```json
{
  "mcpServers": {
    "courtlistener-mcp-server": {
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
    "courtlistener-mcp-server": {
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
    "courtlistener-mcp-server": {
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
- A CourtListener API token — free account at [courtlistener.com](https://www.courtlistener.com/sign-in/). CourtListener publishes free-tier limits of 5 req/min, 50 req/hr, 125 req/day; actual limits vary by token tier. [Free Law Project membership](https://free.law/donate/) unlocks higher limits.

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
| `COURTLISTENER_API_TOKEN` | **Required.** API token from your CourtListener account settings. CourtListener's published free-tier limits are 5 req/min, 50/hr, 125/day; actual limits vary by token tier. | — |
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
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). 14 tools across opinions, citations, dockets, parties, judges, financial disclosures, courts, and oral arguments. |
| `src/services/courtlistener` | CourtListener REST API client — auth, retry, rate-limit error classification. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools by importing them in `src/index.ts` and adding to the `createApp({ tools: [...] })` array
- Wrap CourtListener API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
