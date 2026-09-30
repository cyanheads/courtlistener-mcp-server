<div align="center">
  <h1>@cyanheads/courtlistener-mcp-server</h1>
  <p><b>Search and retrieve US court opinions, federal dockets, judge records, citation networks, and oral arguments from CourtListener's 9M+ opinion corpus via MCP. STDIO or Streamable HTTP.</b>
  <div>14 Tools • 1 Resource • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.7.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/courtlistener-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/courtlistener-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/courtlistener-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/courtlistener-mcp-server/releases/latest/download/courtlistener-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=courtlistener-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY291cnRsaXN0ZW5lci1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22courtlistener-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcourtlistener-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://courtlistener.caseyjhand.com/mcp](https://courtlistener.caseyjhand.com/mcp)

</div>

---

## Overview

US case law and federal court records from CourtListener's 9M+ opinion corpus and its RECAP mirror of PACER. Search opinions and dockets, trace citation networks, resolve citations, look up judges and courts, and read oral argument transcripts and judicial financial disclosures. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `courtlistener_search_opinions` | Full-text search across 9M+ court opinions with field syntax, court, date, and status filters |
| `courtlistener_get_opinion` | Fetch an opinion cluster's metadata and the full text of every variant (majority, concurrence, dissent) |
| `courtlistener_get_citations` | Trace a cluster's citation network: opinions it cites (`citing`) or that cite it (`cited_by`) |
| `courtlistener_lookup_citation` | Resolve every citation in a text (e.g. "410 U.S. 113") to cluster IDs and case metadata |
| `courtlistener_search_dockets` | Search RECAP federal dockets by case name, party, attorney, court, and filing date |
| `courtlistener_get_docket` | Fetch a federal docket's metadata and paged entry list with document availability |
| `courtlistener_get_parties` | Fetch the parties and attorneys of record on a RECAP docket |
| `courtlistener_search_judges` | Search judges by name, appointing president, court, and political affiliation |
| `courtlistener_get_judge` | Fetch a judge's positions, education, political affiliations, and ABA ratings |
| `courtlistener_lookup_courts` | List courts by jurisdiction type, active/inactive status, and scraper coverage |
| `courtlistener_search_oral_arguments` | Search appellate oral argument recordings by case name, transcript text, court, and argument date |
| `courtlistener_get_oral_argument` | Fetch one oral argument's panel, duration, MP3 link, and speech-to-text transcript |
| `courtlistener_search_financial_disclosures` | Search judicial financial disclosure filings by judge and year |
| `courtlistener_get_financial_disclosure` | Fetch one disclosure's line items with coded values decoded to dollar ranges |

### Resources

| Resource | Description |
|:---|:---|
| `courtlistener://reference/courts` | Jurisdiction codes, common court IDs, search type codes, rate limits, and the maintenance window |

The jurisdiction codes are also listed on the `jurisdiction` parameter of `courtlistener_lookup_courts`, for clients that don't surface resources.

### Prompts

| Prompt | Description |
|:---|:---|
| `courtlistener_research_topic` | Generate a structured legal research plan for a topic or question |

## Capability reference

### `courtlistener_search_opinions` <sub>tool</sub>

- `q` is required and takes CourtListener field syntax (`caseName:"roe v wade"`, `court_id:scotus`, `judge:"Alito"`) and `AND` / `OR` / `NOT`; filter by `court`, `filed_after` / `filed_before`, and `status`, and sort with `order_by` (`score desc` default, `dateFiled desc`, `dateFiled asc`, `citeCount desc`); 20 results per page, continued with `next_cursor`
- Each result carries `cluster_id` (for `courtlistener_get_opinion` and `courtlistener_get_citations`), `docket_id`, `cite_count`, a `snippet`, and `opinions[]` variants with opinion ID, `type`, `author_id`, and `local_path`; `totalCount` and `effectiveQuery` report the match

---

### `courtlistener_get_opinion` <sub>tool</sub>

- `cluster_id` is required; after an outline response, `sections: ["opinion_<id>", ...]` pulls specific variants, and a name the cluster doesn't have fails as `unknown_section`
- Cluster metadata (case name, `court_id`, citations, `cite_count`, `precedential_status`, syllabus, posture, `docket_id`) plus each variant's `html_text`, `plain_text`, `cites[]`, `download_url`, and `type_label`, the same label `courtlistener_search_opinions` reports
- `kind` is `full`, or `outline` when the variants overflow the inline budget: the response then lists them as retrievable `opinion_<id>` sections and keeps the cluster metadata

---

### `courtlistener_get_citations` <sub>tool</sub>

- `cluster_id` is required; `direction` is `cited_by` (default, opinions that cite this one) or `citing` (opinions it cites); optional `court` and `filed_after` filters; up to 20 results per page, continued with `cursor`
- Rows carry `cluster_id`, `court_id`, `date_filed`, `cite_count`, and `snippet`; for `citing`, `totalCount` counts the unfiltered cited-opinion list, and a filtered page can come back empty while `next_cursor` is still set

---

### `courtlistener_lookup_citation` <sub>tool</sub>

- `citation` takes one citation or a passage of up to 64,000 characters, and every citation in it resolves; `max_court_lookups` (default 4, max 20, `0` to skip) caps the docket requests spent on court names
- One `matches[]` entry per citation, with `status` (200 one case, 300 several candidates, 400 unrecognized reporter, 404 no match, 429 past the per-request citation cap) and `status_label`; each of its `clusters[]` carries `cluster_id`, `docket_id`, `court_id`, and `court_resolution` (`resolved`, `no_docket`, `lookup_failed`, `over_budget`, only the last worth retrying with a larger budget)
- Unresolved citations come back as entries, not errors; only text with no parseable citation fails, as `not_found`. CourtListener meters this endpoint per citation submitted, separately from the per-request limits

---

### `courtlistener_search_dockets` <sub>tool</sub>

- `q` is required and matches case name, docket number, party, and attorney names; `party_name` (ANDed with `q`), `court`, and `filed_after` / `filed_before` narrow it; 20 results per page, continued with `next_cursor`
- Each docket carries `docket_id`, `parties`, `attorneys`, `firms`, `suit_nature`, `assigned_to` / `referred_to`, and up to 3 `sample_documents` with `is_available` and a RECAP `filepath_local` URL; every response adds a `coverage_note` on RECAP's partial PACER coverage

---

### `courtlistener_get_docket` <sub>tool</sub>

- `docket_id` is required; entries come 20 per page (CourtListener ignores `entries_page_size`), walked with `entries_page`
- Returns docket metadata, `total_entries`, `next_cursor` (the next `entries_page` number), and `entries[]` whose `documents[]` carry `is_available`, `page_count`, and `filepath_local`; documents with `is_available: false` need PACER, and fetching them is not exposed

---

### `courtlistener_get_parties` <sub>tool</sub>

- `docket_id` is required; `cursor` takes the opaque `next_cursor` token, not a page number; `page_size` (max 10) is a request CourtListener may not honor
- Each party carries `name`, its docket-scoped `role`, and `attorneys[]` with `name`, `contact_raw`, `role_code` / `role` (codes 5–9 mean no longer of record), and `date_action`; `total_parties` uses the upstream total when supplied, otherwise counts a single-page result or stays null

---

### `courtlistener_search_judges` <sub>tool</sub>

- `q` is required; filter by `appointer` (the president's last name), `court`, and `political_affiliation` (`d`, `r`, `i`, `l`, `g`, `u`); 20 results per page, continued with `next_cursor`
- Results carry `person_id` (for `courtlistener_get_judge`), `political_affiliation` and `aba_rating` as labels rather than codes, and a `current_position`: the one with no termination date, or the latest-starting when several or none qualify

---

### `courtlistener_get_judge` <sub>tool</sub>

- `person_id` is required; positions are fetched up to a page bound, and `truncated` with `positionsShown` reports when a long record ran past it
- Positions (judicial, plus non-judicial roles described by `job_title` and `organization_name`), education, political affiliations, ABA ratings, and `fjc_id`; coded fields keep the raw code beside a label (`position_type_label`, `termination_reason_label`, `degree_label`)
- Dates carry the precision CourtListener recorded in `dob_granularity`, `dod_granularity`, `date_start_granularity`, and `date_termination_granularity` (`year`, `month`, or `day`)

---

### `courtlistener_lookup_courts` <sub>tool</sub>

- Filter by `jurisdiction` (one of 22 CourtListener codes such as `F`, `FD`, `FB`, `S`, `SA`; the full table is in `courtlistener://reference/courts`), `status` (`active` default, `inactive`, or `any`), and `has_opinion_scraper`; live records come 20 per page, walked with `page`
- `courts[]` carry `id` (the court ID every other tool filters on), `citation_string`, `jurisdiction`, and scraper flags; `all_matching_court_ids` lists every match from a bundled snapshot at no request cost, and is empty when more than 1,000 match, so check `all_matching_court_ids_complete`

---

### `courtlistener_search_oral_arguments` <sub>tool</sub>

- `q` is required and matches case name and transcript text; filter by `court` and `argued_after` / `argued_before`; 20 results per page, continued with `next_cursor`
- Results carry `audio_id` (for `courtlistener_get_oral_argument`), `panel_ids` (for `courtlistener_get_judge`), `duration_seconds`, `snippet`, and two MP3 links: `download_url` at the originating court and `local_path`, CourtListener's durable copy

---

### `courtlistener_get_oral_argument` <sub>tool</sub>

- `id` (an `audio_id` from a search) is required; `sections: ["transcript"]` pulls a transcript that an outline response withheld
- Returns `panel_ids`, `duration_seconds`, `download_url`, `docket_id`, `has_transcript`, and `transcript`; `kind` is `outline` when the transcript overflows the inline budget. The argument date is not on this record; take it from the search result or the docket

---

### `courtlistener_search_financial_disclosures` <sub>tool</sub>

- Filter by `judge_id` (a `person_id`) and `year`; 20 filings per page, continued with `cursor`. `year` filters only the fetched page, because CourtListener has no server-side year filter, so keep paging when a page comes back empty with `next_cursor` set
- Each filing carries `disclosure_id`, `report_type`, `has_been_extracted`, `is_amended`, `pdf_url`, per-category `counts` (investments, gifts, debts, positions, reimbursements, agreements, non-investment and spouse income), and itemized `gifts`

---

### `courtlistener_get_financial_disclosure` <sub>tool</sub>

- `disclosure_id` is required; `categories` selects from `investments`, `debts`, `positions`, `reimbursements`, `non_investment_incomes`, `spouse_incomes`, `agreements`, and `gifts` (omit for all)
- Returns filing metadata, `counts`, and the requested line-item rows, with coded value and income columns decoded to dollar ranges (`N` → `$250,001 - $500,000`); `kind` is `outline` when the full itemization overflows, listing categories by size for a `categories` re-call

---

### `courtlistener://reference/courts` <sub>resource</sub>

- Markdown reference: the 22 jurisdiction codes (rendered from the set `courtlistener_lookup_courts` validates against), common court IDs, search type codes, the published free-tier rate limits, and the weekly maintenance window (Thursdays 21:00–23:59 PT)
- Static content, cacheable publicly for 24 hours

---

### `courtlistener_research_topic` <sub>prompt</sub>

- Arguments: `topic` required; `jurisdiction` optional (a court ID such as `scotus` or `ca9`); `depth` optional, `overview` (default, 3–5 key cases) or `deep` (adds citation-network traversal and judge lookup)
- Returns one user message laying out the research workflow and a findings template: key cases, precedent trajectory, research gaps

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

CourtListener-specific:

- CourtListener REST API v4: search, opinions and clusters, dockets and entries, parties and attorneys, people and positions, courts, audio, financial disclosures, and citation lookup
- One request queue for the whole process, paced to `COURTLISTENER_RATE_LIMIT_PER_MINUTE` and `COURTLISTENER_RATE_LIMIT_PER_HOUR`, so a burst waits instead of failing; a 429 pauses the queue for every waiting call, and a `Retry-After` is honored within a 45-second wait budget
- Request cost per call: one for most tools; two for `courtlistener_get_docket`; two or more for `courtlistener_get_parties` and `courtlistener_get_judge` (one per extra page of a long roster or career); three for `courtlistener_get_opinion` and `courtlistener_get_citations` (plus one per extra page of opinion variants); and for `courtlistener_lookup_citation`, the lookup plus up to `max_court_lookups` docket requests
- Input that can't succeed (an empty `q`, a malformed date, a citation over 64,000 characters, an unknown oral argument section) is rejected before a request is spent

Agent-friendly output:

- Chaining IDs: `cluster_id`, `docket_id`, `person_id`, `audio_id`, and `disclosure_id` appear wherever they feed a follow-up call, with field descriptions naming the tool that takes each
- Typed rate-limit errors: `reason: "rate_limited"` with `retryAfter` in seconds, whether CourtListener returned the 429 or the queue gave up before sending, in which case the message says no request was spent
- Outlines instead of oversized payloads: `courtlistener_get_opinion`, `courtlistener_get_oral_argument`, and `courtlistener_get_financial_disclosure` return `kind: "outline"` with named sections to re-call for
- Coverage caveats inline: RECAP `coverage_note`, `court_resolution` on citation lookups, `truncated` on position history, and notices when a page-local filter empties a page that has more pages behind it

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

Add the following to your MCP client configuration file. Generate a free API token in your [CourtListener account settings](https://www.courtlistener.com/profile/settings/).

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

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A CourtListener API token from a free account at [courtlistener.com](https://www.courtlistener.com/sign-in/). The published free-tier limits are 5 requests per minute, 50 per hour, and 125 per day; actual limits vary by token tier, and [Free Law Project membership](https://free.law/donate/) raises them.

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

| Variable | Description | Default |
|:---|:---|:---|
| `COURTLISTENER_API_TOKEN` | **Required.** API token from your CourtListener account settings. | — |
| `COURTLISTENER_BASE_URL` | API base URL override. | `https://www.courtlistener.com/api/rest/v4` |
| `COURTLISTENER_RATE_LIMIT_PER_MINUTE` | Requests the server starts per rolling minute. Past it, requests queue; one that can't start within about 45 s fails with the reset time. Raise it to match a higher token tier. | `5` |
| `COURTLISTENER_RATE_LIMIT_PER_HOUR` | Requests the server starts per rolling hour. | `50` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. The server declares `stateless`; setting this overrides it. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base endpoint for traces and metrics; appends `/v1/traces` and `/v1/metrics`. Without an endpoint, neither exports. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Explicit endpoint for redacted OTLP logs; the base endpoint does not enable log export. | — |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed-call inputs and results with key-based redaction. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | Size cap for each logged failed-call payload. | `16384` |

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
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers tools, resources, and prompts, and inits the service. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). 14 tools across opinions, citations, dockets, parties, judges, courts, oral arguments, and financial disclosures. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). Court reference resource. |
| `src/mcp-server/prompts` | Prompt definitions (`*.prompt.ts`). Legal research prompt. |
| `src/services/courtlistener` | CourtListener API client (request pacing, retry, error classification), code tables, and the bundled court snapshot (`bun run courts:snapshot` regenerates it). |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools, resources, and prompts by importing them in `src/index.ts` and adding them to the `createApp({ tools, resources, prompts })` arrays
- Wrap CourtListener API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
