# courtlistener-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `courtlistener_search_opinions` | Full-text search across 9M+ written court opinions with field-level filtering | `q`, `court`, `filed_after`, `filed_before`, `status`, `order_by`, `page_size` | `readOnlyHint`, `openWorldHint` |
| `courtlistener_get_opinion` | Fetch the full text and metadata for a single opinion cluster by cluster ID | `cluster_id` | `readOnlyHint`, `idempotentHint` |
| `courtlistener_get_citations` | Retrieve the citation network for an opinion: what it cites, and what cites it | `cluster_id`, `direction`, `page_size` | `readOnlyHint`, `openWorldHint` |
| `courtlistener_search_dockets` | Search RECAP federal court dockets with party name, attorney, court, and date filters | `q`, `court`, `filed_after`, `filed_before`, `party_name`, `page_size` | `readOnlyHint`, `openWorldHint` |
| `courtlistener_get_docket` | Fetch docket metadata and entries for a single federal case by docket ID | `docket_id` | `readOnlyHint`, `idempotentHint` |
| `courtlistener_get_parties` | Fetch parties and attorneys of record for a RECAP federal docket | `docket_id`, `cursor`, `page_size` | `readOnlyHint`, `idempotentHint` |
| `courtlistener_search_judges` | Search judge/person records by name, appointing president, court, political affiliation, or demographic | `q`, `appointer`, `court`, `political_affiliation`, `page_size` | `readOnlyHint`, `openWorldHint` |
| `courtlistener_get_judge` | Fetch biographical profile, appointment history, and education for a single judge | `person_id` | `readOnlyHint`, `idempotentHint` |
| `courtlistener_lookup_courts` | List courts filtered by jurisdiction type, active/inactive status, and scraper coverage | `jurisdiction`, `status`, `has_opinion_scraper` | `readOnlyHint`, `openWorldHint` |
| `courtlistener_lookup_citation` | Resolve legal citations (e.g., "410 U.S. 113") to cluster IDs and case metadata — one entry per citation found in the input | `citation` | `readOnlyHint`, `idempotentHint` |
| `courtlistener_search_oral_arguments` | Search appellate oral argument audio recordings by case name, court, and date argued | `q`, `court`, `argued_after`, `argued_before`, `page_size` | `readOnlyHint`, `openWorldHint` |

---

## Overview

**courtlistener-mcp-server** exposes the CourtListener/RECAP dataset — 9M+ full-text federal and state court opinions, PACER-sourced docket data, judge biographical records, and an opinion citation network — via the CourtListener REST API v4.4.

The primary use case is legal research and precedent analysis: finding relevant opinions, tracing how a landmark decision's reasoning has propagated through subsequent rulings, looking up a judge's background, and cross-referencing court activity with legislative and regulatory actions.

Built on [Free Law Project's](https://free.law/) open-access infrastructure. Opinions are government works in the public domain; bulk data carries Public Domain Mark (CC PDM 1.0).

---

## Requirements

- CourtListener API token (free account at courtlistener.com) — required for all endpoints except `/courts/`; the search endpoint works unauthenticated but rate limits are tighter
- Rate limits — **very tight on the free tier:** CourtListener publishes 5 req/min, 50 req/hr, 125 req/day, and all three windows apply simultaneously; actual limits vary by token tier, so the Retry-After returned on a 429 is the authoritative wait, not the published figure. Free Law Project membership or commercial agreement unlocks higher limits. Every tool design must respect this: most tools make 1–2 upstream calls, opinion detail and either citation direction spend three (plus one per extra page of opinion variants on a case that filed many), and the ceiling is the five citation lookup spends when it resolves the courts of four distinct dockets. `/citation-lookup/` is additionally metered by citations submitted rather than by call, so one request over a long passage can consume several citations' worth of quota.
- RECAP docket coverage is crowd-sourced from PACER — completeness varies by court and case. Treat docket data as "best available" not authoritative.
- The citation network lives in the search index (`cites:(id)` query) — no dedicated citation REST endpoint is accessible unauthenticated. The authenticated `/opinions-cited/` endpoint is the higher-fidelity path with auth.
- No write operations exposed to the tool surface (RECAP upload, alerts, tags are all excluded)
- CourtListener has a weekly maintenance window: Thursdays 21:00–23:59 PT

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `CourtListenerService` | CourtListener REST API v4 | All tools |

Single service, single base URL. Auth via `Authorization: Token <token>` header. Resilience: retry with exponential backoff on 429 (respect Retry-After if present) and 5xx; parse-failure detection for HTML error pages. Rate limit awareness: track whether 429s are minute vs. hour vs. day window and surface which throttle triggered in error messages.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `COURTLISTENER_API_TOKEN` | Yes | API token from courtlistener.com account settings. CourtListener's published free-tier limits are 5 req/min, 50/hr, 125/day; actual limits vary by token tier. |
| `COURTLISTENER_BASE_URL` | No | Override API base URL (default: `https://www.courtlistener.com/api/rest/v4`) |

---

## Domain Mapping

| Noun | Operations | Endpoint |
|:-----|:-----------|:---------|
| Opinion cluster | search, get | `/search/?type=o`, `/clusters/{id}/` |
| Docket | search, get | `/search/?type=r`, `/dockets/{id}/` |
| Parties/attorneys | get (by docket) | `/parties/?docket={id}`, `/attorneys/` (batch) |
| Judge/person | search, get | `/search/?type=p`, `/people/{id}/` |
| Court | list/filter | `/courts/` |
| Oral argument | search | `/search/?type=oa` |
| Citations | cited-by, cites | `/search/?q=cites:(id)&type=o`, `/opinions-cited/?citing_opinion={id}` |
| Citation string | resolve | `/citation-lookup/` (POST, auth required) |

**Not tooled (excluded):**
- RECAP upload, email, fetch (`/recap/`, `/recap-email/`, `/recap-fetch/`) — write operations
- Alerts/docket-alerts — user account management
- Tags/docket-tags — organizational tooling
- Financial disclosures — separate domain; data quality and ID linkage complexity not justified for initial release
- Visualizations — SCOTUS-specific, niche utility
- Party cross-docket aggregation or entity-resolution across cases

---

## Implementation Order

1. Config and server setup (`server-config.ts`, `COURTLISTENER_API_TOKEN`)
2. `CourtListenerService` — base client with auth, retry, rate-limit error classification
3. `courtlistener_search_opinions` — primary entry point for most workflows
4. `courtlistener_get_opinion` — single cluster fetch
5. `courtlistener_get_citations` — citation network via search + optional opinions-cited
6. `courtlistener_lookup_citation` — citation string resolver (POST to `/citation-lookup/`)
7. `courtlistener_search_judges` + `courtlistener_get_judge`
8. `courtlistener_lookup_courts` — reference data
9. `courtlistener_search_dockets` + `courtlistener_get_docket`
10. `courtlistener_search_oral_arguments`

Each step is independently testable.

---

## Tool Detail

### `courtlistener_search_opinions`

Search the 9M+ opinion corpus. Returns a list of opinion cluster summaries with embedded opinion snippets.

**Input schema:**
```ts
q: z.string()
  .describe('Full-text query. Supports field syntax (caseName:"roe v wade", court_id:scotus, judge:"Alito") and boolean operators (AND, OR, NOT). Use plain English for semantic-style queries or legal citations.'),
court: z.string().optional()
  .describe('Filter to a specific court by court ID (e.g., "scotus", "ca9", "nyed"). Use courtlistener_lookup_courts to find court IDs.'),
filed_after: z.string().optional()
  .describe('Earliest filing date (ISO 8601, e.g., "2020-01-01"). Narrows search to opinions filed on or after this date.'),
filed_before: z.string().optional()
  .describe('Latest filing date (ISO 8601). Narrows search to opinions filed before or on this date.'),
status: z.enum(['Published', 'Unpublished', 'Errata', 'Separate', 'In-chambers', 'Relating-to', 'Unknown']).optional()
  .describe('Opinion publication status. "Published": precedential. "Unpublished": not citable as precedent in most jurisdictions. "Errata": corrections. "Separate": separate opinion filed outside main cluster. "In-chambers": single-justice order. "Relating-to": companion or related-case order. Omit to search all statuses.'),
order_by: z.enum(['score desc', 'dateFiled desc', 'dateFiled asc', 'citeCount desc']).optional().default('score desc')
  .describe('Result ordering. "score desc" (default) ranks by relevance. "citeCount desc" surfaces most-cited opinions first.'),
page_size: z.number().int().min(1).max(20).optional().default(10)
  .describe('Number of results (1–20, default 10). Keep low — each search costs one request against the rate limit.'),
cursor: z.string().optional()
  .describe('Pagination cursor from a previous response\'s next_cursor field. Omit for the first page.'),
```

**Output:**
```ts
{
  total_count: number,          // total matching opinions
  results: Array<{
    cluster_id: number,         // primary ID for follow-up calls
    case_name: string,
    case_name_full: string,
    court: string,
    court_id: string,           // chaining: pass to court filter
    date_filed: string,
    docket_number: string,
    docket_id: number,          // chaining: courtlistener_get_docket
    citations: string[],        // formatted citation strings (e.g., "410 U.S. 113")
    cite_count: number,         // how many times this opinion has been cited
    judges: string,
    status: string,
    snippet: string,            // matched text excerpt
  }>,
  next_cursor: string | null,   // pagination token
}
```

**Errors:**
| Reason | Code | When | Retryable |
|:-------|:-----|:-----|:----------|
| `rate_limited` | `ServiceUnavailable` | 429 response; minute, hour, or day throttle | Yes — after window resets |
| `invalid_query` | `InvalidParams` | Malformed field syntax or invalid `type` value | Yes — fix query |

---

### `courtlistener_get_opinion`

Fetch full text and metadata for an opinion cluster. A cluster groups all opinions filed in a case (majority, concurrence, dissent, per curiam). Returns the full text of each opinion variant.

**Input schema:**
```ts
cluster_id: z.number().int()
  .describe('Opinion cluster ID — identifies a case decision and groups all opinion variants (majority, concurrence, dissent). Obtain from courtlistener_search_opinions, courtlistener_lookup_citation, or from docket results that link to opinions.'),
```

**Output:**
```ts
{
  cluster_id: number,
  case_name: string,
  case_name_full: string,
  court: string,
  court_id: string,
  date_filed: string,
  docket_id: number,
  docket_number: string,
  judges: string,
  citations: string[],
  cite_count: number,          // total citations from other opinions
  precedential_status: string,
  syllabus: string,
  posture: string,
  opinions: Array<{
    id: number,
    type: string,              // "lead-opinion", "concurrence", "dissent", "combined-opinion"
    author_id: number | null,
    per_curiam: boolean,
    html_text: string,         // full opinion text as HTML
    plain_text: string,        // plain text version if available
    cites: number[],           // opinion IDs this opinion cites
    download_url: string | null,
  }>,
}
```

**Errors:**
| Reason | Code | When | Retryable |
|:-------|:-----|:-----|:----------|
| `not_found` | `NotFound` | Cluster ID does not exist | Yes — verify ID from search |
| `rate_limited` | `ServiceUnavailable` | 429 | Yes |

---

### `courtlistener_get_citations`

Retrieve the citation network for an opinion cluster. Supports two directions: opinions cited BY this opinion (outbound references) and opinions that CITE this opinion (inbound — measures precedential influence). This is the primary tool for tracing legal precedent chains.

Note on depth: the free tier supports shallow traversal — following 1–2 hops of a single important case is practical; deep multi-hop analysis across 10+ cases exhausts the daily budget quickly. Citation data shows *what* cites *what*, not *how* — whether a precedent was affirmed, distinguished, or limited requires reading the citing opinion text via `courtlistener_get_opinion`.

**Input schema:**
```ts
cluster_id: z.number().int()
  .describe('Opinion cluster ID to retrieve citations for. Identifies a case decision; obtain from courtlistener_search_opinions or courtlistener_lookup_citation.'),
direction: z.enum(['citing', 'cited_by']).default('cited_by')
  .describe('"cited_by" (default): opinions that cite this one — measures precedential influence and downstream adoption. "citing": opinions this one cites — reveals the authority chain the court relied on.'),
court: z.string().optional()
  .describe('Filter results to a specific court (e.g., "scotus", "ca9"). Applies to both directions.'),
filed_after: z.string().optional()
  .describe('Limit to citations filed after this date (ISO 8601). For "cited_by", useful for "how has this precedent been applied recently?"'),
page_size: z.number().int().min(1).max(20).optional().default(10)
  .describe('Number of results (1–20). Each citation tool call costs one request against the rate limit — keep page_size low for multi-hop traversal.'),
cursor: z.string().optional()
  .describe('Pagination cursor from a previous response\'s next_cursor field.'),
```

**Output:**
```ts
{
  source_cluster_id: number,
  source_case_name: string,
  direction: 'citing' | 'cited_by',
  total_count: number,
  results: Array<{
    cluster_id: number,
    case_name: string,
    court: string,
    court_id: string,
    date_filed: string,
    citations: string[],
    cite_count: number,       // this opinion's own citation count (its authority weight)
    snippet: string,          // text excerpt showing context around the citation
  }>,
  next_cursor: string | null,
}
```

**Implementation note:** For `cited_by`, use `GET /search/?q=cites:(cluster_id)&type=o` (1 upstream request). For `citing`, call `GET /clusters/{id}/` internally and extract the inline `cites[]` array (1 upstream request — the opinion cluster record includes outbound citation IDs). Both directions cost 1 upstream call.

**Errors:**
| Reason | Code | When | Retryable |
|:-------|:-----|:-----|:----------|
| `rate_limited` | `ServiceUnavailable` | 429 | Yes |

---

### `courtlistener_lookup_citation`

Resolve legal citations (e.g., "410 U.S. 113", "93 S. Ct. 705") to opinion cluster IDs and case metadata. Enables workflows that start from a known citation rather than a search query. Upstream parses the submitted text with eyecite and answers per citation found, so the output is a list, not a single record.

**Input schema:**
```ts
citation: z.string().trim()
  .describe('Text to extract citations from — normally a single citation (e.g., "410 U.S. 113", "347 U.S. 483", "93 S. Ct. 705"), but any passage works and every citation in it is resolved. Supports standard reporter formats. Up to 64,000 characters, which is CourtListener's own ceiling.'),
max_court_lookups: z.number().int().min(0).max(MAX_COURT_BACKFILL_LIMIT).optional().default(COURT_BACKFILL_LIMIT)
  .describe('How many distinct dockets this call may spend a request on to resolve cluster courts. 0 skips court resolution; MAX_COURT_BACKFILL_LIMIT (20) is the ceiling.'),
```

Blank and oversized input are both rejected before the request is sent — `CitationAPIRequestSerializer.text` is a `CharField(max_length=64_000)`, so a longer passage is refused upstream after the request is already spent.

**Output:**
```ts
{
  matches: Array<{
    citation: string,                    // as upstream matched it in the text
    normalized_citation: string | null,  // canonical form CourtListener uses
    status: number,                      // per-citation: 200 one case, 300 several
                                         // candidates, 400 unrecognized reporter,
                                         // 404 no match, 429 past the citation cap
    status_label: string,
    error_message: string,               // upstream's explanation; '' when status is 200
    clusters: Array<{
      cluster_id: number | null,
      case_name: string | null,
      court: string | null,              // backfilled from docket_id — see note
      court_id: string | null,
      court_resolution: 'resolved' | 'no_docket' | 'lookup_failed' | 'over_budget',
      date_filed: string | null,
      docket_id: number | null,
      citations: string[],               // all known citations for this case
      cite_count: number | null,
      precedential_status: string | null,
      judges: string | null,
    }>,
  }>,
}
```

**Implementation note:** Uses `POST /citation-lookup/` with `{"text": citation}`. `IsAuthenticated` is on the viewset, so there is no unauthenticated path and no search fallback. Upstream returns `[]` only when eyecite parsed no citation at all — that is the sole `not_found` case; a citation that parses but matches nothing is an entry with `status: 404`. The embedded `OpinionClusterSerializer` has no `court` field (the court lives on the linked docket), so `court`/`court_id` are resolved from `docket_id` at one `/dockets/{id}/` request each, sequentially, bounded by `max_court_lookups` (default `COURT_BACKFILL_LIMIT`); the walk stops early on the first rate-limited response. Each cluster's `court_resolution` names why a court is or isn't populated, and the response notice separately counts clusters left unresolved by budget exhaustion versus a failed lookup — only the former is worth retrying with a larger budget.

**Errors:**
| Reason | Code | When | Retryable |
|:-------|:-----|:-----|:----------|
| `not_found` | `NotFound` | No citation could be parsed from the submitted text | No — reformat the citation |
| `rate_limited` | `RateLimited` | 429 | No — honor Retry-After |
| `empty_citation` | `ValidationError` | `citation` is empty or whitespace-only after trimming | No — supply a citation |
| `citation_too_long` | `ValidationError` | `citation` exceeds the 64,000-character ceiling CourtListener accepts | No — trim or split the passage |

---

### `courtlistener_search_dockets`

Search RECAP federal court dockets. RECAP is a crowd-sourced mirror of PACER (the federal court filing system) — coverage varies by court and date. Returns docket metadata with up to 3 sample document entries per docket.

**Input schema:**
```ts
q: z.string()
  .describe('Query terms matched against case name, docket number, party names, and attorney names. Example: "Apple Inc patent infringement".'),
court: z.string().optional()
  .describe('Filter to a specific federal court ID (e.g., "dnd", "cacd", "deb" for Delaware Bankruptcy). Use courtlistener_lookup_courts to find court IDs.'),
party_name: z.string().optional()
  .describe('Filter to dockets listing a specific party by name — applied in addition to (AND with) the q query, not instead of it. More precise than including party names in q when the party name is known.'),
filed_after: z.string().optional()
  .describe('Earliest case filing date (ISO 8601).'),
filed_before: z.string().optional()
  .describe('Latest case filing date (ISO 8601).'),
page_size: z.number().int().min(1).max(10).optional().default(5)
  .describe('Number of results (1–10). Lower limit than opinion search — docket results embed document lists and are larger payloads.'),
cursor: z.string().optional()
  .describe('Pagination cursor from a previous response\'s next_cursor field.'),
```

**Output:**
```ts
{
  total_count: number,
  results: Array<{
    docket_id: number,          // chaining: courtlistener_get_docket
    case_name: string,
    court: string,
    court_id: string,
    date_filed: string,
    date_terminated: string | null,
    docket_number: string,
    pacer_case_id: string | null,
    assigned_to: string | null,
    cause: string,
    jury_demand: string,
    parties: string[],
    document_count: number,
    sample_documents: Array<{   // up to 3 sample filings
      id: number,
      description: string,
      date_filed: string,
      document_number: number | null,
      is_available: boolean,
    }>,
  }>,
  next_cursor: string | null,
  coverage_note: string,        // "RECAP coverage is partial. Documents with is_available=false require a PACER account or CourtListener RECAP filing — fetching their PDFs is not exposed by this server."
}
```

---

### `courtlistener_get_docket`

Fetch full docket metadata and entry list for a single federal case. Returns all available docket entries with document availability status.

**Input schema:**
```ts
docket_id: z.number().int()
  .describe('Docket ID from a search result\'s docket_id field or from an opinion cluster result.'),
entries_page_size: z.number().int().min(1).max(50).optional().default(20)
  .describe('Number of docket entries to return (1–50). Large cases can have hundreds of entries.'),
```

**Output:**
```ts
{
  docket_id: number,
  case_name: string,
  case_name_full: string,
  court: string,
  court_id: string,
  date_filed: string,
  date_terminated: string | null,
  docket_number: string,
  pacer_case_id: string | null,
  assigned_to: string | null,
  referred_to: string | null,
  cause: string,
  jury_demand: string,
  jurisdiction_type: string,
  total_entries: number,
  entries: Array<{
    id: number,
    entry_number: number | null,
    date_filed: string,
    description: string,
    documents: Array<{
      id: number,
      document_number: number | null,
      attachment_number: number | null,
      description: string,
      is_available: boolean,
      page_count: number | null,
      filepath_local: string | null,  // URL if available via RECAP
    }>,
  }>,
}
```

---

### `courtlistener_search_judges`

Search judge/person records. Returns biographical data, appointment history, and position list.

**Input schema:**
```ts
q: z.string()
  .describe('Search query — judge name, court, city, or relevant keywords.'),
appointer: z.string().optional()
  .describe('Filter by appointing president\'s last name (e.g., "Obama", "Trump", "Biden"). Matches against the appointer field in position records.'),
court: z.string().optional()
  .describe('Filter to judges who have held a position at this court (e.g., "scotus", "ca9"). Use court_id strings from courtlistener_lookup_courts.'),
political_affiliation: z.enum(['d', 'r', 'i', 'l', 'g', 'u']).optional()
  .describe('Filter by political affiliation: d=Democrat, r=Republican, i=Independent, l=Libertarian, g=Green Party, u=Unknown/unconfirmed. Based on party of the appointing president or election affiliation.'),
page_size: z.number().int().min(1).max(20).optional().default(10)
  .describe('Number of results (1–20).'),
cursor: z.string().optional()
  .describe('Pagination cursor from a previous response\'s next_cursor field.'),
```

**Output:**
```ts
{
  total_count: number,
  results: Array<{
    person_id: number,          // chaining: courtlistener_get_judge
    name: string,
    gender: string,
    dob: string | null,
    dob_city: string | null,
    dob_state: string | null,
    political_affiliation: string[],
    aba_rating: string[],
    schools: string[],
    current_position: {
      court: string | null,
      court_id: string | null,
      position_type: string | null,
      appointer: string | null,
      date_start: string | null,
    } | null,
  }>,
  next_cursor: string | null,
}
```

---

### `courtlistener_get_judge`

Fetch full biographical profile for a single judge: appointment history across all courts, education, political affiliations, and ABA ratings.

**Input schema:**
```ts
person_id: z.number().int()
  .describe('Judge person ID from a search result\'s person_id field. Identifies a specific judge across all courts they have served on.'),
```

**Output:**
```ts
{
  person_id: number,
  name: string,
  gender: string,
  dob: string | null,
  dob_city: string | null,
  dob_state: string | null,
  dod: string | null,
  fjc_id: string | null,        // Federal Judicial Center ID (cross-reference)
  aba_ratings: string[],
  political_affiliations: Array<{
    affiliation: string,
    date_start: string | null,
    date_end: string | null,
  }>,
  education: Array<{
    school: string,
    degree: string | null,
    year: number | null,
  }>,
  positions: Array<{
    court: string,
    court_id: string,           // chaining: filter opinions by this judge's court
    position_type: string,      // e.g., "District Judge", "Circuit Judge", "Justice"
    appointer: string | null,
    nomination_process: string | null,
    date_nominated: string | null,
    date_confirmation: string | null,
    date_start: string | null,
    date_termination: string | null,
    termination_reason: string | null,
  }>,
}
```

---

### `courtlistener_lookup_courts`

List courts with optional filtering by jurisdiction type, active/inactive status, and scraper coverage. Primarily used to discover court IDs for use in search and filter parameters.

**Input schema:**
```ts
jurisdiction: z.enum(['F', 'FD', 'FB', 'FBP', 'FS', 'C', 'I', 'T', 'ST', 'SS', 'SAG', 'SAL', 'SA', 'S', 'TT']).optional()
  .describe('Jurisdiction type. F=Federal Appellate (circuit courts, SCOTUS), FD=Federal District, FB=Federal Bankruptcy, FBP=Federal Bankruptcy Panel, FS=Federal Special (USITC, FISC, etc.), C=Circuit (historical), I=International, T=Territory, ST=State Trial, SS=State Supreme, SAG=State Attorney General, SAL=State Legislature, SA=State Appellate, S=State (other), TT=Tribal/Territory. Omit to list all.'),
// Upstream's `in_use` is a boolean exact-match filter, so in_use=true and in_use=false
// return disjoint sets whose sizes sum to the unfiltered total. A forwarded boolean
// cannot express "both", which is what the tri-state exists for: 'active' → in_use=true,
// 'inactive' → in_use=false, 'any' → the parameter is omitted.
status: z.enum(['active', 'inactive', 'any']).optional().default('active')
  .describe("Which bench to return. 'active' (default) returns only courts CourtListener currently scrapes; 'inactive' returns only the historical and defunct courts it no longer scrapes; 'any' returns both."),
has_opinion_scraper: z.boolean().optional()
  .describe('Filter to courts with active opinion scraping. Useful when planning search queries — courts without scrapers have sparse coverage.'),
```

**Output:**
```ts
{
  total_count: number,
  courts: Array<{
    id: string,                  // court_id for use in search filters
    full_name: string,
    short_name: string,
    citation_string: string,     // e.g., "9th Cir.", "SCOTUS"
    jurisdiction: string,
    has_opinion_scraper: boolean,
    has_oral_argument_scraper: boolean,
  }>,
  all_matching_court_ids: string[],          // complete filtered id set from a bundled
                                              // snapshot, no request cost; empty (not a
                                              // prefix) when the match count exceeds a
                                              // 1,000-id inlining ceiling
  all_matching_court_ids_complete: boolean,  // false only when the ceiling was hit
}
```

The snapshot (`src/services/courtlistener/court-names-data.ts`, regenerate via `bun run courts:snapshot`) covers all courts, active and historical — `/courts/` itself stays authoritative for full records and anything changed since the snapshot date.

---

### `courtlistener_search_oral_arguments`

Search appellate oral argument audio recordings — the largest public collection of oral argument audio. Returns recording metadata with download URL.

**Input schema:**
```ts
q: z.string()
  .describe('Query terms matched against case name and transcribed argument text (where available).'),
court: z.string().optional()
  .describe('Filter to a specific court (e.g., "scotus", "ca9").'),
argued_after: z.string().optional()
  .describe('Earliest date the case was argued (ISO 8601) — filters by argument date, not publication date.'),
argued_before: z.string().optional()
  .describe('Latest date the case was argued (ISO 8601).'),
page_size: z.number().int().min(1).max(20).optional().default(10)
  .describe('Number of results (1–20).'),
cursor: z.string().optional()
  .describe('Pagination cursor from a previous response\'s next_cursor field.'),
```

**Output:**
```ts
{
  total_count: number,
  results: Array<{
    audio_id: number,
    case_name: string,
    court: string,
    court_id: string,
    date_argued: string | null,
    docket_id: number,
    docket_number: string,
    judges: string,
    panel_ids: number[],         // chaining: courtlistener_get_judge
    duration_seconds: number,
    download_url: string | null, // MP3 download URL
    local_path: string | null,
    snippet: string,             // transcript excerpt where available
  }>,
  next_cursor: string | null,
}
```

---

## Workflow Analysis

### "Find case law on topic X" (most common)
| # | Call | Tool |
|:--|:-----|:-----|
| 1 | Search opinions by keyword | `courtlistener_search_opinions(q="topic")` |
| 2 | Fetch full text of most relevant | `courtlistener_get_opinion(cluster_id)` |

### "Trace precedent from landmark case"
| # | Call | Tool |
|:--|:-----|:-----|
| 1 | Resolve known citation to cluster ID | `courtlistener_lookup_citation(citation="410 U.S. 113")` |
| 2 | Find opinions that cite it (precedent spread) | `courtlistener_get_citations(cluster_id, direction="cited_by")` |
| 3 | Fetch notable downstream opinion | `courtlistener_get_opinion(cluster_id)` |

### "Look up a judge's record"
| # | Call | Tool |
|:--|:-----|:-----|
| 1 | Search for judge | `courtlistener_search_judges(q="name", court="scotus")` |
| 2 | Full biography + appointment history | `courtlistener_get_judge(person_id)` |
| 3 | Find their authored opinions (optional) | `courtlistener_search_opinions(q='judge:"Last Name"', court=court_id)` |

### "Find docket entries for a case"
| # | Call | Tool |
|:--|:-----|:-----|
| 1 | Search for docket | `courtlistener_search_dockets(q="party name", court="cacd")` |
| 2 | Full docket with entries | `courtlistener_get_docket(docket_id)` |

### "What courts should I search?"
| # | Call | Tool |
|:--|:-----|:-----|
| 1 | List active federal appellate courts | `courtlistener_lookup_courts(jurisdiction="F")` |

---

## Design Decisions

**Rate limits drive everything.** At the published free-tier windows (5 req/min, 50/hr, 125/day), a single complex agent session can exhaust the daily budget. Consequences:
- No workflow tool spends more than three upstream requests, plus one per extra page of opinion variants a cluster needs
- `page_size` defaults are kept low (5–10) and maximums are capped (10–20)
- No "fetch related data" enrichment in responses that would auto-trigger extra calls
- `courtlistener_get_citations` uses the search endpoint rather than paginating the `/opinions-cited/` REST endpoint across multiple pages; both directions first resolve the source cluster's opinion IDs, since the `cites:` index is keyed by opinion, not cluster
- Deep citation traversal (multi-hop: "what cites X, then what cites those 10 cases") burns through daily budget in one session. The server exposes the tool correctly but the rate-limit constraint is a free-tier reality. Free Law Project membership ($10/mo) unlocks higher limits for research use.

**Citation network via search, not dedicated endpoint.** The `/opinions-cited/` REST endpoint requires auth and consumes daily quota per page. The search API's `cites:(id)` filter returns rich metadata for the whole network from one search call. That search is not free-standing, though: `cites:` keys on opinion IDs, and the `citing` direction reads the cluster's inline `cites[]`, so both directions resolve the cluster's opinion variants first — three calls per invocation, not one.

**No financial disclosures tool in v1.** The endpoint is public and interesting, but requires traversing a person ID → disclosure ID → investment/income sub-resources chain (3–4 calls minimum) with low structured-data density. Deferred to a future `courtlistener_get_financial_disclosure` tool.

**Clusters vs. opinions distinction.** The search API returns `cluster_id` (the grouping of all opinions in a case), not individual opinion IDs. The `get_opinion` tool returns the full cluster with all opinion variants (majority, dissent, concurrence). This matches user mental model — "get me Obergefell" means the whole decision, not one opinion type.

**No oral argument detail tool.** Audio recordings return download URLs directly in search results — including `duration_seconds`, panel judge IDs, and `snippet` transcript text. A separate `get_oral_argument` tool would cost one request per recording with minimal additional data over what search already returns. Unlike opinions or dockets, there is no analysis workflow that needs to fetch an audio record's full details after discovery; the download URL is the deliverable. Deferred to v2 if demand arises.

**Document retrieval not exposed.** RECAP documents with `is_available: true` have a `filepath_local` URL pointing to a stored PDF. Fetching and parsing PDFs adds significant handler complexity (binary fetch, format conversion) and is gated on PACER account status for unavailable documents. The tool surface surfaces document metadata and availability so agents know what exists — actual retrieval is left to the user.

---

## Known Limitations

- **A tight daily free-tier budget** (125 req/day published; varies by token tier). A session doing search + get + citations + judge lookup spends roughly 8–10 requests. Heavy users hit the daily cap within hours. Server should surface rate-limit state in error messages, distinguishing minute/hour/day throttle.
- **RECAP docket coverage is partial.** Not all PACER documents are publicly available — those marked `is_available: false` require RECAP filing or payment via CourtListener. The tool surface cannot fix this.
- **Opinion text may be partial or HTML.** Some opinions link to `download_url` with no local text stored. The `get_opinion` handler should surface the download URL when text is absent.
- **Citation network is approximate.** CourtListener's citation extraction is automated — minor formatting variants can miss links. `cite_count` is directional guidance, not a definitive legal citation count.
- **No state court docket data.** RECAP is federal courts only (PACER). State court dockets are not available.

---

## API Reference

### Search type codes
| Code | Data |
|:-----|:-----|
| `o` | Opinion clusters (default) |
| `r` | Federal dockets with up to 3 nested docs |
| `rd` | PACER documents only |
| `d` | Federal dockets without document metadata |
| `p` | Judges/people |
| `oa` | Oral argument audio |

### Opinion search field syntax
- `caseName:`, `court_id:`, `judge:`, `docketNumber:`, `cites:(id)`, `status:`
- Date range: `filed_after`, `filed_before` as query params (not field syntax)
- Boolean: `AND`, `OR`, `NOT`

### Pagination
- `/search/`-backed tools (opinions, dockets, judges, oral arguments, citation network) are cursor-based (opaque string in `next` URL): do NOT use `page=N` — cursor pagination is required for consistent results
- Which paginator a non-`/search/` list endpoint gets is per-viewset, not a property of "non-search endpoints" as a class — check the viewset before assuming. `cl/api/pagination.py`'s `VersionBasedPagination` (the DRF default here) routes a v4 request to `CursorPagination` when the effective ordering key is in the viewset's `cursor_ordering_fields`, and to `PageNumberPagination` otherwise. A viewset that sets `pagination_class` explicitly opts out entirely.
- Page-number paginated, exposing a 1-indexed `page` input: `/docket-entries/` (`courtlistener_get_docket`) and `/courts/` (`courtlistener_lookup_courts` — `CourtViewSet.pagination_class = PageNumberPagination`, the plain DRF paginator with no cursor support). Each caps the page at ~20 rows regardless of `page_size` and returns the next page number as `next_cursor`
- Cursor paginated, exposing an opaque `cursor` input: `/parties/` (`courtlistener_get_parties`) and `/attorneys/`. Both inherit `VersionBasedPagination` and default to `CursorPagination` because their `ordering = "-id"` sits inside `cursor_ordering_fields`. A page number sent here selects nothing and re-serves the first page. The tell in a live response: these emit `count` as a *URL string* rather than an integer, which upstream only does on its cursor branch

### Rate limit throttles (published free tier; actual limits vary by token tier)
| Window | Published limit |
|:-------|:----------------|
| Per minute | 5 requests |
| Per hour | 50 requests |
| Per day | 125 requests |

All three windows apply simultaneously. The most restrictive active throttle controls. 429 response includes `Retry-After` header.
