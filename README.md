<div align="center">
  <h1>@cyanheads/courtlistener-mcp-server</h1>
  <p><b>Search and retrieve US court opinions, federal dockets, judge records, citation networks, and oral arguments from CourtListener's 9M+ opinion corpus via MCP. STDIO or Streamable HTTP.</b>
  <div>14 Tools • 2 Resources • 1 Prompt</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.9.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/courtlistener-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/courtlistener-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/courtlistener-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/courtlistener-mcp-server/releases/latest/download/courtlistener-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=courtlistener-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY291cnRsaXN0ZW5lci1tY3Atc2VydmVyIl0sImVudiI6eyJDT1VSVExJU1RFTkVSX0FQSV9UT0tFTiI6InlvdXItYXBpLXRva2VuIn19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22courtlistener-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcourtlistener-mcp-server%22%5D%2C%22env%22%3A%7B%22COURTLISTENER_API_TOKEN%22%3A%22your-api-token%22%7D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://courtlistener.caseyjhand.com/mcp](https://courtlistener.caseyjhand.com/mcp)

</div>

---

## Overview

US case law and federal court records from CourtListener's 9M+ opinion corpus and its RECAP mirror of PACER. Search opinions and dockets, trace citation networks, resolve citations, look up judges and courts, and read oral argument transcripts and judicial financial disclosures.

### Tools

| Tool | Description |
|:---|:---|
| `courtlistener_search_opinions` | Full-text search across 9M+ court opinions with field syntax, court, date, and status filters |
| `courtlistener_get_opinion` | Fetch an opinion cluster's metadata and variant text (majority, concurrence, dissent), with source-completion status |
| `courtlistener_get_citations` | Trace a cluster's citation network: opinions it cites (`citing`) or that cite it (`cited_by`) |
| `courtlistener_lookup_citation` | Resolve every citation in a text (e.g. "410 U.S. 113") to cluster IDs and case metadata |
| `courtlistener_search_dockets` | Search RECAP federal dockets by case name, party, attorney, court, and filing date |
| `courtlistener_get_docket` | Fetch a federal docket's paged entries or selected filings' extracted text |
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
| `skill://courtlistener-guide/SKILL.md` | Research guide for identifier chains, text completion, citation treatment, and coverage limits |

The jurisdiction codes are also listed on the `jurisdiction` parameter of `courtlistener_lookup_courts`, for clients that don't surface resources.

### Prompts

| Prompt | Description |
|:---|:---|
| `courtlistener_research_topic` | Generate a structured legal research plan for a topic or question |

## Capability reference

Result-page sizes accept positive integers and bound outgoing requests: 20 for searches/citations, 10 for parties, and 50 for docket entries. Both response surfaces carry `page_sizing` (`requested`, `bounded`, `actual`, `upstream`). Upstream search/disclosure pages have a 20-row minimum, parties/entries use fixed 20-row pages, and citing slices cited IDs before searching. Returned pages are preserved; empty/final pages and page-local filters can produce fewer rows. Continue with the native cursor rather than increasing the requested size.

Opinion, docket, judge, and oral-argument searches accept `q: "*"` for filter-only queries. Their `court` filter, and the citation tool's, accepts space- or comma-separated IDs and resolves known IDs case-insensitively to their canonical spelling. Unfamiliar IDs retain their casing and still reach CourtListener; use `courtlistener_lookup_courts` to check them.

### `courtlistener_search_opinions` <sub>tool</sub>

- `q` is required and takes CourtListener field syntax (`caseName:"roe v wade"`, `court_id:scotus`, `judge:"Alito"`) and `AND` / `OR` / `NOT`; filter by `court`, `filed_after` / `filed_before`, and `status`, and sort with `order_by` (`score desc` default, `dateFiled desc`, `dateFiled asc`, `citeCount desc`); 20 results per page, continued with `next_cursor`
- Each result carries `cluster_id` (for `courtlistener_get_opinion` and `courtlistener_get_citations`), `docket_id`, `cite_count`, a `snippet`, and `opinions[]` variants with opinion ID, `type`, `author_id`, and `local_path`; `totalCount` and `effectiveQuery` report the match
- Omit `status` for CourtListener's Published default, or select one publication status, including `In-chambers` and `Relating-to`.
- `snippet` uses the first variant with an upstream excerpt. Highlighting requests query context; filter-only queries can still return opening text or no excerpt. Highlight markup is removed without losing its words.
- Variant `cites` arrays are omitted by default. Use `include: ["cites"]` for complete cited-opinion IDs at the existing `opinions[].cites` path.

---

### `courtlistener_get_opinion` <sub>tool</sub>

- `cluster_id` is required; after an outline response, `sections: ["opinion_<id>", ...]` pulls specific variants, and a name the cluster doesn't have fails as `unknown_section`
- Cluster metadata (case name, `court_id`, citations, `cite_count`, `precedential_status`, syllabus, posture, `docket_id`) plus each variant's `html_text`, `plain_text`, `cites[]`, `download_url`, and `type_label`, the same label `courtlistener_search_opinions` reports
- Outline entries identify each variant's `type_label`, `author_id`, and `per_curiam`. Select `text: "plain"` or `"html"` to retrieve only that text representation; omission or `"both"` keeps both. Keep the text mode unchanged on continuations.
- Small responses use `kind: "full"`. Oversized variants or metadata return a bounded `outline`, then typed `page` responses through `retrieval.next_cursor`; repeat the original ID and selection with `cursor` until null.
- Supplied `plain_text` is preserved; markup-only variants gain readable text with paragraphs, tables, lists, footnotes, and decoded entities. `html_text` retains raw source and renders as fenced text. Search/citation snippets use the same readable normalization.
- `variants_completion` reports whether the bounded source walk finished and its remaining upstream variant cursor. `docket_enrichment` distinguishes `not_linked`, `resolved`, `source_fields_absent`, and `lookup_failed` with a sanitized failure category; cancellation propagates.
- Primary continuation remains stable when optional docket enrichment changes. Oversized enrichment has its own `enrichment_retrieval.next_cursor`, passed as `enrichment_cursor` with the same cluster and selection. Keep enrichment chunks only while `source_id` is unchanged; a changed source restarts that stream. A metadata-only partial response can have a null primary cursor while enrichment continues. Legacy v1 cursors retain their original enrichment-sensitive behavior.

---

### `courtlistener_get_citations` <sub>tool</sub>

- `cluster_id` is required; `direction` is `cited_by` (default, opinions that cite this one) or `citing` (opinions it cites); optional `court`, `filed_after`, `filed_before`, and `statuses` filters; up to 20 results per page, continued with `cursor`. Omit `statuses` for CourtListener's Published default or select one or more statuses. `order_by` applies only to `cited_by`.
- Rows carry `cluster_id`, `court_id`, `date_filed`, `cite_count`, and `snippet`; for `citing`, totals count the unfiltered cited-opinion list, and a filtered page can come back empty while `next_cursor` is still set. `source_variants_completion` and `total_is_partial` qualify `observed_total`; incomplete variants make this a lower bound and omit the exact `totalCount` trailer.
- Citation snippets remain opening excerpts. Inbound totals count matching clusters after the selected filters; repeat filters and sorting on continuation.
- For `citing`, `cursor` is a nonnegative safe decimal integer offset (`01`, `+1`, `1.0`, and `1.` all mean `1`); malformed offsets fail as `invalid_cursor` before any request. An offset at or past the end returns an empty page with the source name and unfiltered distinct-opinion total, without searching. `cited_by` cursors stay opaque.

---

### `courtlistener_lookup_citation` <sub>tool</sub>

- `citation` takes one citation or a passage of up to 64,000 characters, and every citation in it resolves; `max_court_lookups` (default 4, max 20, `0` to skip) caps the docket requests spent on court names
- One `matches[]` entry per citation, with `status` (200 one case, 300 several candidates, 400 unrecognized reporter, 404 no match, 429 past the per-request citation cap) and `status_label`; each of its `clusters[]` carries `cluster_id`, `docket_id`, `court_id`, and `court_resolution` (`resolved`, `no_docket`, `lookup_failed`, `over_budget`, only the last worth retrying with a larger budget)
- Unresolved citations come back as entries, not errors; only text with no parseable citation fails, as `not_found`. CourtListener meters this endpoint per citation submitted, separately from the per-request limits

---

### `courtlistener_search_dockets` <sub>tool</sub>

- `q` is required and matches case name, docket number, party, and attorney names; `party_name` (ANDed with `q`), `court`, and `filed_after` / `filed_before` narrow it; 20 results per page, continued with `next_cursor`
- Each docket carries `docket_id`, `party_count`, `attorney_count`, `firm_count`, `suit_nature`, `assigned_to` / `referred_to`, and up to 3 `sample_documents` with `is_available` and a RECAP `filepath_local` URL; every response adds a `coverage_note` on RECAP's partial PACER coverage. Counts describe indexed name arrays, with null for an absent array and zero for an empty array.
- Select complete name arrays with `include: ["parties", "attorneys", "firms"]`; no additional request is needed. Use `courtlistener_get_parties` for docket-scoped representation. `totalCount` is approximate for large result sets.

---

### `courtlistener_get_docket` <sub>tool</sub>

- `docket_id` is required; entries come 20 per page (CourtListener ignores `entries_page_size`), walked with `entries_page` and top-level `next_cursor`. Convert the cursor string to a number: `next_cursor: "2"` continues with `entries_page: 2`. Without a document selection, returns docket metadata and `entries[]`; `total_entries` is null when upstream supplies no numeric total.
- Listing metadata includes linked `cluster_ids` for `courtlistener_get_opinion`, `audio_ids` for `courtlistener_get_oral_argument`, `date_argued`, `suit_nature`, `appeal_from`, and `date_last_filing`.
- Entries are ordered by ascending entry number. For a positive known total, `ceil(total_entries / 20)` identifies the last page in that ordering only when it is at most 100, CourtListener's page limit. Use entry dates to identify the latest filings; a null total cannot locate a last page.
- `document_ids` selects documents from the requested entries page. Selected responses carry `kind`, `selected_documents`, source/storage links, and raw `plain_text`; large records use `retrieval.next_cursor`, passed as `cursor` with the same docket ID, entries page, and selection. Listing-only fields are optional in selected responses.
- `text_status` is `available`, `unavailable`, `not_extracted`, or `unknown`; extracted text can exist independently of `is_available`. IDs absent from the page fail as `document_not_on_page`; an entry without a matching docket relation fails as `document_ownership_unverified`. Selection adds no document-detail requests or page walks.

---

### `courtlistener_get_parties` <sub>tool</sub>

- `docket_id` is required; `cursor` takes the opaque `next_cursor` token, not a page number; outgoing `page_size` is bounded to 10 and CourtListener may not honor it
- Each party carries `name`, its docket-scoped `role`, and `attorneys[]` with `name`, `contact_raw`, `role_code` / `role` (codes 5–9 mean no longer of record), and `date_action`; `total_parties` uses the upstream total when supplied, otherwise counts a single-page result or stays null
- `attorney_resolution` reports resolved, exhausted, or capped lookups, unresolved IDs, and the remaining upstream roster cursor. Resolution stops after five roster pages or when the local request budget blocks a later page; already fetched records are retained. Per-attorney `resolution` distinguishes a resolved record with empty source fields from `not_found` after exhaustion and `not_fetched` after the cap. Upstream roster/variant cursors describe completeness; these tools do not accept them as new retrieval inputs.

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
- Highlighting requests matched transcript context when upstream supplies it; filter-only queries may return opening text or an empty excerpt. Highlighted names and other metadata remain readable text.

---

### `courtlistener_get_oral_argument` <sub>tool</sub>

- `id` (an `audio_id` from a search) is required; `sections: ["transcript"]` selects the transcript. Selected responses obey the same byte limits.
- Returns `panel_ids`, `duration_seconds`, `download_url` at the court, `local_path` for CourtListener's MP3 copy, `docket_id`, `has_transcript`, and `transcript`; oversized text or metadata uses `outline` and cursor-driven `page` responses. The argument date is not on this record; take it from the search result or the docket.

---

### `courtlistener_search_financial_disclosures` <sub>tool</sub>

- Filter by `judge_id` (a `person_id`) and `year`; 20 filings per page, continued with `cursor`. `year` filters only the fetched page, because CourtListener has no server-side year filter, so keep paging when a page comes back empty with `next_cursor` set
- Each filing carries `disclosure_id`, `report_type`, `has_been_extracted`, `is_amended`, `pdf_url`, per-category `counts` (investments, gifts, debts, positions, reimbursements, agreements, non-investment and spouse income), and itemized `gifts`
- Use `courtlistener_get_financial_disclosure` for decoded investment line items; the PDF remains the source filing.

---

### `courtlistener_get_financial_disclosure` <sub>tool</sub>

- `disclosure_id` is required; `categories` selects from `investments`, `debts`, `positions`, `reimbursements`, `non_investment_incomes`, `spouse_incomes`, `agreements`, and `gifts` (omit for all)
- Returns filing metadata, `counts`, and the requested line-item rows, with coded value and income columns decoded to dollar ranges (`N` → `$250,001 - $500,000`); oversized selections use `outline` and cursor-driven `page` responses, including when a single row exceeds the budget.

Opinion, audio, disclosure, and selected docket-document retrieval bound each serialized response surface (`structuredContent` and complete `content[]`) to 24,000 UTF-8 bytes. Repeat the original identity and selection with `cursor: retrieval.next_cursor`; docket selections also repeat `entries_page`. Catalog pages lead automatically to data pages. `retrieval.ranges` uses JSON Pointer paths and absolute exclusive ranges (`rows`, `code_points`, or `sections`); merge typed rows by absolute index, and concatenate `text_chunks` by their code-point ranges. Partial rows retain their source identity; omitted text is recoverable through its original field path. Metadata can also be paged. Structured strings remain unescaped; presentation escaping happens after slicing. A changed normalized source returns `stale_cursor`; restart without cursor. Source-completion cursors remain distinct from these retrieval cursors.

First calls fetch fresh source. Matching continuations can reuse a source snapshot for five minutes from `source_fetched_at`, which appears on both response surfaces. Opinion docket enrichment stays live on every call. Expiry, eviction, process restart, or an oversized source causes a fresh fetch; the existing cursor resumes only if the normalized source still matches. Snapshots are isolated by tenant and upstream service, with 16 MiB of serialized payload retained across at most 256 entries. A missing tenant bypasses caching. Restart without a cursor when fresh source is needed.

| Retrieval | First call or cold continuation | Warm continuation |
|:---|:---|:---|
| Opinion | Cluster + variant pages + linked docket, normally 3 requests | Linked docket only, normally 1 request |
| Selected docket documents | Docket + requested entries page: 2 requests | 0 requests |
| Oral argument | 1 request | 0 requests |
| Financial disclosure | 1 request | 0 requests |

Opinion legacy v1 cursors and enrichment-only calls use fresh primary source. Docket listings without `document_ids` always use two requests. Extra opinion variant pages add one request each; an unlinked opinion omits the docket request. Counts exclude retries.

---

### `courtlistener://reference/courts` <sub>resource</sub>

- Markdown reference: the 22 jurisdiction codes (rendered from the set `courtlistener_lookup_courts` validates against), common court IDs, search type codes, the published free-tier rate limits, and the weekly maintenance window (Thursdays 21:00–23:59 PT)
- Static content, cacheable publicly for 24 hours

---

### `skill://courtlistener-guide/SKILL.md` <sub>resource</sub>

- Identifier chains and research gates for case law, RECAP filings, judges, disclosures, and oral arguments
- Also included in plugin installs, npm, Docker, and the desktop bundle as [courtlistener-guide](./skills/courtlistener-guide/SKILL.md)

---

### `courtlistener_research_topic` <sub>prompt</sub>

- Arguments: `topic` required; `jurisdiction` optional (a court ID such as `scotus` or `ca9`); `depth` optional, `overview` (default, 3–5 key cases) or `deep` (adds citation-network traversal and judge lookup)
- Returns one user message laying out the research workflow and a findings template: key cases, precedent trajectory, research gaps

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

CourtListener-specific:

- CourtListener REST API v4: search, opinions and clusters, dockets and entries, parties and attorneys, people and positions, courts, audio, financial disclosures, and citation lookup
- One request queue for the whole process, paced to `COURTLISTENER_RATE_LIMIT_PER_MINUTE` and `COURTLISTENER_RATE_LIMIT_PER_HOUR`, so a burst waits instead of failing; a 429 pauses the queue for every waiting call, and a `Retry-After` is honored within a 45-second wait budget
- Request cost: one for most tools; two or more for parties and judge detail; normally three for citations, plus extra variant pages; citation lookup plus up to `max_court_lookups` docket requests. Detail retrieval first/warm/cold costs are listed above.
- Input that can't succeed (an empty `q`, a malformed date, a citation over 64,000 characters, an unknown oral argument section) is rejected before a request is spent

Agent-friendly output:

- Chaining IDs: `cluster_id`, `docket_id`, `person_id`, `audio_id`, and `disclosure_id` appear wherever they feed a follow-up call, with field descriptions naming the tool that takes each
- Typed rate-limit errors: `reason: "rate_limited"` with `retryAfter` in seconds, whether CourtListener returned the 429 or the queue refused the current request; earlier requests in the same tool call may already have completed
- Bounded retrieval: opinion, audio, disclosure, and selected docket-document responses preserve small full records and stream oversized selections through an outline and resumable typed pages without truncating source text
- Coverage caveats inline: RECAP `coverage_note`, `court_resolution` on citation lookups, `truncated` on position history, and notices when a page-local filter empties a page that has more pages behind it

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http courtlistener-mcp-server https://courtlistener.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add courtlistener-mcp-server -e COURTLISTENER_API_TOKEN=your-api-token -- npx -y @cyanheads/courtlistener-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "courtlistener-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/courtlistener-mcp-server"],
      "env": {
        "COURTLISTENER_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Generate a token in your [CourtListener account settings](https://www.courtlistener.com/profile/settings/). Published free-tier limits are 5 requests per minute, 50 per hour, and 125 per day; limits vary by token tier, and [Free Law Project membership](https://free.law/donate/) raises them. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `COURTLISTENER_API_TOKEN` | **Required.** API token from your CourtListener account settings. | — |
| `COURTLISTENER_BASE_URL` | API base URL override. | `https://www.courtlistener.com/api/rest/v4` |
| `COURTLISTENER_RATE_LIMIT_PER_MINUTE` | Requests the server starts per rolling minute. Past it, requests queue; one that can't start within about 45 s fails with the reset time. Raise it to match a higher token tier. | `5` |
| `COURTLISTENER_RATE_LIMIT_PER_HOUR` | Requests the server starts per rolling hour. | `50` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP route path. The framework normalizes the path and rejects URLs, queries, and fragments. | `/mcp` |
| `MCP_PUBLIC_URL` | Public HTTP(S) base URL behind a proxy. The URL cannot contain credentials, a query, or a fragment. | — |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. The server declares `stateless`; setting this overrides it. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_JWT_EXPECTED_AUDIENCE` | Required JWT audience when set. JWT mode warns at startup when the audience is unset. | — |
| `MCP_JWT_EXPECTED_ISSUER` | Required JWT issuer when set. Configure alongside the audience. | — |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). Relative paths resolve from the server package. Use an absolute path to store logs elsewhere. | `<server-package-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Base endpoint for traces and metrics; appends `/v1/traces` and `/v1/metrics`. Without an endpoint, neither exports. | — |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | Explicit endpoint for redacted OTLP logs; the base endpoint does not enable log export. | — |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log failed-call inputs and results with key-based redaction. | `false` |
| `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` | Size cap for each logged failed-call payload. | `16384` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/courtlistener-mcp-server.git
  cd courtlistener-mcp-server && bun install
  cp .env.example .env   # set COURTLISTENER_API_TOKEN
  ```

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
docker run --rm -e COURTLISTENER_API_TOKEN=your-token -p 3010:3010 ghcr.io/cyanheads/courtlistener-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/courtlistener-mcp-server`. For stdio, use `docker run -i --rm -e MCP_TRANSPORT_TYPE=stdio -e COURTLISTENER_API_TOKEN=your-token ghcr.io/cyanheads/courtlistener-mcp-server:latest`. To build locally, run `docker build -t courtlistener-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

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
| `skills/` | Published research guidance for agents calling the server. |

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
