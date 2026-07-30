/**
 * @fileoverview CourtListener REST API v4 client service. Handles auth, retry,
 * rate-limit classification, and response normalization for all tools.
 * @module services/courtlistener/courtlistener-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  notFound,
  rateLimited,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { expandCode } from './codes.js';
import { resolveCourtName } from './court-names.js';
import type {
  AttorneyDetail,
  AttorneyRelationship,
  Audio,
  AudioSearchResult,
  CitationCluster,
  CitationMatch,
  Court,
  CourtListenerPage,
  CourtResolution,
  Docket,
  DocketEntry,
  DocketSearchResult,
  FinancialDisclosure,
  Opinion,
  OpinionCluster,
  OpinionSearchResult,
  Party,
  PartyType,
  Person,
  PersonPosition,
  PersonSearchResult,
} from './types.js';
import { idFromUri } from './uri.js';

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Cursor pages walked while resolving attorney detail. CourtListener paginates
 * `/attorneys/` at a fixed 20 rows — it ignores `page_size` on this endpoint — so this
 * caps detail resolution at the first ~100 attorneys of a docket's roster. The walk
 * stops as soon as every needed ID is resolved, so a typical docket costs one call;
 * a roster past the cap logs a warning and leaves the surplus names empty.
 */
const ATTORNEY_PAGE_LIMIT = 5;

/**
 * Cursor pages walked while collecting a cluster's opinion variants. `/opinions/` is
 * cursor-paginated (`OpinionViewSet.ordering = "-id"`, with `id` among its
 * `cursor_ordering_fields`), so a single fetch drops every variant past the first page.
 * Whether the endpoint honors `page_size` is unconfirmed — `/attorneys/` ignores it — so
 * the bound counts pages, not rows. A cluster carries a handful of variants in practice,
 * so the walk normally costs one call; hitting the bound warns instead of truncating
 * silently. It also bounds the ID list `getCitedBy` ORs into one query string.
 */
const SUB_OPINION_PAGE_LIMIT = 5;

/**
 * Cursor pages walked while collecting a person's positions. `/positions/` is
 * cursor-paginated (`PositionViewSet.ordering = "-id"`, with `id` among its
 * `cursor_ordering_fields`), and the viewset declares no `pagination_class`, so it
 * inherits `VersionBasedPagination` — whose cursor paginator is constructed with no
 * `page_size_query_param` and the DRF-wide `PAGE_SIZE` of 20. `page_size` is therefore
 * ignored here, and the bound counts pages, not rows. Upstream stores every role a
 * person held as its own row — judgeships, clerkships, prosecutor and academic stints —
 * so a long career runs past one page; hitting the bound reports the truncation to the
 * caller instead of presenting a partial history as whole.
 */
const POSITION_PAGE_LIMIT = 5;

/**
 * Default number of distinct dockets resolved to a court name while normalizing a
 * citation lookup. The embedded cluster carries no court, so each one costs its own
 * `/dockets/{id}/` request — and one submitted text can carry many citations.
 *
 * The two halves of the call draw on separate upstream budgets: `/citation-lookup/`
 * sets `throttle_classes = [CitationCountRateThrottle]`, which meters a private
 * `citations` scope by citations submitted (60/min) and replaces the default throttles
 * entirely, so the lookup spends nothing from the general per-request budget the docket
 * fetches draw on (published free tier: 5/min, 50/hour, 125/day; actual limits vary by
 * token tier). The default therefore spends most — not all — of one minute's general
 * allowance, leaving headroom for whatever else the caller is doing.
 *
 * Callers override it per call via the tool's `max_court_lookups` input, bounded by
 * `MAX_COURT_BACKFILL_LIMIT`. Exported so the tool can name the default on the wire.
 */
export const COURT_BACKFILL_LIMIT = 4;

/**
 * Ceiling on a caller-supplied court-backfill budget. Past a minute's general allowance
 * the walk is throttled rather than fast, so this bounds how much of an hourly budget
 * one call can consume; the walk stops early on the first 429 regardless.
 */
export const MAX_COURT_BACKFILL_LIMIT = 20;

/**
 * CourtListener `Role.ATTORNEY_ROLES` codes (cl/people_db/models.py) → labels.
 * Codes 5–9 mark a relationship that has ended, so the label changes how an entry
 * reads: a "Terminated" attorney is not current counsel. Unknown codes pass through
 * as the stringified code rather than being dropped or guessed.
 */
const ATTORNEY_ROLE_LABELS: Record<string, string> = {
  1: 'Attorney to be noticed',
  2: 'Lead attorney',
  3: 'Attorney in sealed group',
  4: 'Pro hac vice',
  5: 'Self-terminated',
  6: 'Terminated',
  7: 'Suspended',
  8: 'Inactive',
  9: 'Disbarred',
  10: 'Unknown',
};

/** Extract cursor token from a CourtListener next URL. */
function extractCursor(nextUrl: string | null): string | null {
  if (!nextUrl) return null;
  try {
    const url = new URL(nextUrl);
    return url.searchParams.get('cursor');
  } catch {
    return null;
  }
}

/**
 * Resolve a CourtListener docket reference to a numeric ID. `/parties/` serializes
 * `party_types[].docket` as a `.../dockets/<id>/` URL, but older/other shapes send a
 * number or numeric string — accept all three. Returns null when no ID is parseable.
 */
function toDocketId(docket: number | string): number | null {
  if (typeof docket === 'number') return docket;
  const fromUri = idFromUri(docket, 'dockets');
  if (fromUri !== null) return fromUri;
  const n = Number(docket);
  return Number.isFinite(n) ? n : null;
}

/** Classify the rate-limit window from headers or response body. */
function buildRateLimitMessage(retryAfter: string | null): string {
  const base = 'CourtListener rate limit reached.';
  const hint =
    'CourtListener throttles per minute, hour, and day. Check courtlistener.com for membership options.';
  if (retryAfter) {
    return `${base} Retry-After: ${retryAfter}s. ${hint}`;
  }
  return `${base} ${hint}`;
}

/**
 * Domain recovery hints keyed by resource type. Shared between the fetch-error
 * classifier (derives the type from the request path) and the per-resource
 * not-found guards (the 200-with-null-body edge case).
 */
const RECOVERY_HINTS = {
  cluster:
    'Verify the cluster ID via courtlistener_search_opinions or courtlistener_lookup_citation.',
  docket:
    'Verify the docket ID via courtlistener_search_dockets. The docket may not be in RECAP coverage.',
  parties:
    'Verify the docket ID via courtlistener_search_dockets. Parties data requires RECAP coverage for the docket.',
  person: 'Verify the person ID via courtlistener_search_judges.',
  audio: 'Verify the audio ID via courtlistener_search_oral_arguments.',
  disclosure: 'Verify the disclosure ID via courtlistener_search_financial_disclosures.',
} as const;

/** Map a request path to the recovery hint for its resource type. */
function recoveryHintForPath(path: string): string | undefined {
  if (path.includes('/clusters/')) return RECOVERY_HINTS.cluster;
  if (path.includes('/parties/')) return RECOVERY_HINTS.parties;
  if (path.includes('/dockets/')) return RECOVERY_HINTS.docket;
  if (path.includes('/people/')) return RECOVERY_HINTS.person;
  if (path.includes('/audio/')) return RECOVERY_HINTS.audio;
  if (path.includes('/financial-disclosures/')) return RECOVERY_HINTS.disclosure;
  return;
}

/** Not-found error with reason + path-derived recovery hint and a path-only (non-URL-leaking) message. */
function notFoundForPath(path: string) {
  const hint = recoveryHintForPath(path);
  return notFound(`Resource not found: ${path}`, {
    path,
    reason: 'not_found',
    ...(hint ? { recovery: { hint } } : {}),
  });
}

/**
 * `fetchWithTimeout` throws an McpError on every non-2xx response BEFORE the
 * manual status checks below can run — carrying `data.status` (not the
 * machine-readable `data.reason` consumers route on) and leaking the full request
 * URL in its message. Remap the not-found and rate-limit cases to domain errors
 * with a reason + recovery hint and a path-only message; pass everything else
 * (already-classified domain errors, 5xx, timeouts) through untouched.
 */
function classifyFetchError(err: unknown, path: string): unknown {
  const e = err as {
    code?: number;
    data?: { status?: number; reason?: string; retryAfter?: string };
  } | null;
  if (e?.data?.reason) return err; // already a domain error carrying a reason
  const status = e?.data?.status;
  if (status === 404 || e?.code === JsonRpcErrorCode.NotFound) return notFoundForPath(path);
  if (status === 429 || e?.code === JsonRpcErrorCode.RateLimited) {
    // fetchWithTimeout already read CourtListener's Retry-After off the response and put it
    // on the error — carry it through instead of making the agent guess the wait.
    const retryAfter = e?.data?.retryAfter ?? null;
    // retryable: false — CourtListener's free-tier windows are per-minute/hour/day; withRetry's
    // 2/4/8s backoff can never clear them, so fail fast and let the agent honor Retry-After.
    return rateLimited(buildRateLimitMessage(retryAfter), {
      reason: 'rate_limited',
      retryable: false,
      ...(retryAfter && { retryAfter }),
    });
  }
  return err;
}

/**
 * What the service needs to run: the server-specific env config (`getServerConfig()`)
 * plus the running server's version, which lives on the framework config and is
 * reported in the outbound User-Agent.
 */
export interface CourtListenerServiceConfig {
  /** CourtListener API token — required by the env schema, so never absent at runtime. */
  apiToken: string;
  /** API base URL; defaults to the public v4 endpoint. */
  baseUrl?: string;
  /** Running server version — `core.config.mcpServerVersion` in `setup()`. */
  mcpServerVersion: string;
}

export class CourtListenerService {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly userAgent: string;

  constructor(config: CourtListenerServiceConfig, _storage: StorageService) {
    this.baseUrl = config.baseUrl ?? 'https://www.courtlistener.com/api/rest/v4';
    this.token = config.apiToken;
    // Read from the running server's version so a release bump reaches the outbound
    // User-Agent — the value an upstream maintainer attributes traffic by.
    this.userAgent = `courtlistener-mcp-server/${config.mcpServerVersion}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Token ${this.token}`,
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    };
  }

  /** Generic GET with retry, rate-limit detection, and JSON parse. */
  private get<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    ctx: Context,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    const fullUrl = url.toString();
    ctx.log.debug('CourtListener GET', { url: fullUrl });

    // biome-ignore lint/suspicious/noExplicitAny: Context satisfies RequestContext at runtime
    const reqCtx = ctx as unknown as any;

    return withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(fullUrl, REQUEST_TIMEOUT_MS, reqCtx, {
            signal: ctx.signal,
            headers: this.headers(),
            // A 404 is a routine outcome of an agent-supplied ID, not a server fault —
            // log it at debug. The thrown, status-mapped error is unchanged.
            expectedStatuses: [404],
          });
        } catch (err) {
          // fetchWithTimeout throws on non-2xx (status, no reason, leaks URL) — remap it.
          throw classifyFetchError(err, path);
        }

        // Only 2xx reaches here; a non-2xx already threw above.
        const text = await response.text();
        if (/^\s*<(!DOCTYPE|html)/i.test(text)) {
          throw serviceUnavailable(
            'CourtListener returned HTML instead of JSON — likely a maintenance window (Thursdays 21:00–23:59 PT).',
          );
        }
        return JSON.parse(text) as T;
      },
      {
        operation: 'CourtListenerService.get',
        context: reqCtx,
        baseDelayMs: 2000,
        signal: ctx.signal,
      },
    );
  }

  /** POST with JSON body. */
  private post<T>(path: string, body: unknown, ctx: Context): Promise<T> {
    const fullUrl = `${this.baseUrl}${path}`;
    ctx.log.debug('CourtListener POST', { url: fullUrl });

    // biome-ignore lint/suspicious/noExplicitAny: Context satisfies RequestContext at runtime
    const reqCtx = ctx as unknown as any;

    return withRetry(
      async () => {
        let response: Response;
        try {
          response = await fetchWithTimeout(fullUrl, REQUEST_TIMEOUT_MS, reqCtx, {
            method: 'POST',
            signal: ctx.signal,
            headers: { ...this.headers(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            // A 404 here means the citation isn't in the corpus — an expected lookup
            // outcome, so log it at debug. The thrown error is unchanged.
            expectedStatuses: [404],
          });
        } catch (err) {
          // fetchWithTimeout throws on non-2xx (status, no reason, leaks URL) — remap it.
          throw classifyFetchError(err, path);
        }

        // Only 2xx reaches here; a non-2xx already threw above.
        const text = await response.text();
        return JSON.parse(text) as T;
      },
      {
        operation: 'CourtListenerService.post',
        context: reqCtx,
        baseDelayMs: 2000,
        signal: ctx.signal,
      },
    );
  }

  // ── Opinions ──────────────────────────────────────────────────────────────

  async searchOpinions(
    params: {
      q: string;
      court?: string | undefined;
      filed_after?: string | undefined;
      filed_before?: string | undefined;
      status?: string | undefined;
      order_by?: string | undefined;
      page_size?: number | undefined;
      cursor?: string | undefined;
    },
    ctx: Context,
  ): Promise<{ total: number; results: OpinionSearchResult[]; nextCursor: string | null }> {
    const query: Record<string, string | number | boolean | undefined> = {
      q: params.q,
      type: 'o',
      order_by: params.order_by ?? 'score desc',
      filed_after: params.filed_after,
      filed_before: params.filed_before,
      court: params.court,
      count: params.page_size ?? 10,
      cursor: params.cursor,
    };

    // Map status to CourtListener stat_* params
    if (params.status) {
      const statusMap: Record<string, string> = {
        Published: 'stat_Published',
        Unpublished: 'stat_Unpublished',
        Errata: 'stat_Errata',
        Separate: 'stat_Separate',
        'In-chambers': 'stat_In_chambers',
        'Relating-to': 'stat_Relating_to_cases',
        Unknown: 'stat_Unknown',
      };
      const key = statusMap[params.status];
      if (key) query[key] = 'on';
    }

    const data = await this.get<CourtListenerPage<OpinionSearchResult>>('/search/', query, ctx);

    return {
      total: data.count,
      results: data.results,
      nextCursor: extractCursor(data.next),
    };
  }

  async getOpinionCluster(clusterId: number, ctx: Context): Promise<OpinionCluster> {
    const data = await this.get<OpinionCluster>(`/clusters/${clusterId}/`, {}, ctx);
    if (!data?.id) {
      throw notFound(`Opinion cluster ${clusterId} not found.`, {
        reason: 'not_found',
        clusterId,
        recovery: { hint: RECOVERY_HINTS.cluster },
      });
    }
    /**
     * /clusters/{id}/ returns sub_opinions as URI strings — fetch the actual opinion
     * objects. Walk the cursor to the end so a cluster with more variants than one page
     * keeps its tail: the outline in courtlistener_get_opinion and the cited-ID lists
     * behind both citation directions are all built from this list.
     */
    const subOpinions: Opinion[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < SUB_OPINION_PAGE_LIMIT; page++) {
      const opinions = await this.get<CourtListenerPage<Opinion>>(
        '/opinions/',
        { cluster: clusterId, page_size: 20, cursor: cursor ?? undefined },
        ctx,
      );
      subOpinions.push(...opinions.results);
      cursor = extractCursor(opinions.next);
      if (!cursor) break;
    }
    if (cursor) {
      // Say so rather than presenting a truncated variant list as the whole cluster.
      ctx.log.warning('Opinion variants remain unfetched after the page walk', {
        clusterId,
        fetched: subOpinions.length,
        pagesWalked: SUB_OPINION_PAGE_LIMIT,
      });
    }
    data.sub_opinions = subOpinions;
    return data;
  }

  // ── Dockets ───────────────────────────────────────────────────────────────

  async searchDockets(
    params: {
      q: string;
      court?: string | undefined;
      party_name?: string | undefined;
      filed_after?: string | undefined;
      filed_before?: string | undefined;
      page_size?: number | undefined;
      cursor?: string | undefined;
    },
    ctx: Context,
  ): Promise<{ total: number; results: DocketSearchResult[]; nextCursor: string | null }> {
    const query: Record<string, string | number | boolean | undefined> = {
      q: params.q,
      type: 'r',
      court: params.court,
      party_name: params.party_name,
      filed_after: params.filed_after,
      filed_before: params.filed_before,
      count: params.page_size ?? 5,
      cursor: params.cursor,
    };

    const data = await this.get<CourtListenerPage<DocketSearchResult>>('/search/', query, ctx);

    return {
      total: data.count,
      results: data.results,
      nextCursor: extractCursor(data.next),
    };
  }

  async getDocket(
    docketId: number,
    entriesPageSize: number,
    entriesPage: number,
    ctx: Context,
  ): Promise<Docket> {
    const data = await this.get<Docket>(`/dockets/${docketId}/`, {}, ctx);
    if (!data?.id) {
      throw notFound(`Docket ${docketId} not found.`, {
        reason: 'not_found',
        docketId,
        recovery: { hint: RECOVERY_HINTS.docket },
      });
    }
    // /dockets/{id}/ does not include docket_entries — fetch separately from /docket-entries/.
    // /docket-entries/ is page-paginated (?page=N); page_size is ignored upstream (always 20/page).
    const entries = await this.get<CourtListenerPage<DocketEntry>>(
      '/docket-entries/',
      { docket: docketId, page: entriesPage, page_size: entriesPageSize, order_by: 'entry_number' },
      ctx,
    );
    data.docket_entries = entries.results;
    // /docket-entries/ returns `count` as a URL string when its count isn't cached (like
    // /parties/) — keep only a numeric count so total_entries stays a number; the tool falls
    // back to the fetched page length otherwise.
    const rawCount: unknown = entries.count;
    if (typeof rawCount === 'number') {
      data.docket_entries_count = rawCount;
    }
    // `next` is a `...&page=N` URL (no cursor token), so signal the next page by number when
    // upstream reports more entries exist — mirrors getParties' next_cursor derivation.
    data.docket_entries_next_page = entries.next ? String(entriesPage + 1) : null;
    return data;
  }

  /**
   * Lightweight docket metadata fetch (no docket-entries page) used to backfill
   * court_id and docket_number onto an opinion cluster — the /clusters/{id}/
   * endpoint omits both. Single upstream call.
   */
  async getDocketSummary(
    docketId: number,
    ctx: Context,
  ): Promise<{ court_id: string; docket_number: string; case_name: string }> {
    const data = await this.get<Docket>(`/dockets/${docketId}/`, {}, ctx);
    return {
      court_id: data?.court_id ?? '',
      docket_number: data?.docket_number ?? '',
      case_name: data?.case_name ?? '',
    };
  }

  // ── Judges ────────────────────────────────────────────────────────────────

  async searchJudges(
    params: {
      q: string;
      appointer?: string | undefined;
      court?: string | undefined;
      political_affiliation?: string | undefined;
      page_size?: number | undefined;
      cursor?: string | undefined;
    },
    ctx: Context,
  ): Promise<{ total: number; results: PersonSearchResult[]; nextCursor: string | null }> {
    const query: Record<string, string | number | boolean | undefined> = {
      q: params.q,
      type: 'p',
      appointer: params.appointer,
      court: params.court,
      political_affiliation: params.political_affiliation,
      count: params.page_size ?? 10,
      cursor: params.cursor,
    };

    const data = await this.get<CourtListenerPage<PersonSearchResult>>('/search/', query, ctx);

    return {
      total: data.count,
      results: data.results,
      nextCursor: extractCursor(data.next),
    };
  }

  async getPerson(personId: number, ctx: Context): Promise<Person> {
    const data = await this.get<Person>(`/people/${personId}/`, {}, ctx);
    if (!data?.id) {
      throw notFound(`Person ${personId} not found.`, {
        reason: 'not_found',
        personId,
        recovery: { hint: RECOVERY_HINTS.person },
      });
    }
    /**
     * /people/{id}/ returns positions as URI strings — fetch the actual position objects
     * separately, walking the cursor to the end so a long career keeps its tail. No
     * `page_size`: the endpoint ignores it (see `POSITION_PAGE_LIMIT`), so sending one
     * implies a size upstream will never honor.
     */
    const positions: PersonPosition[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < POSITION_PAGE_LIMIT; page++) {
      const positionsPage = await this.get<CourtListenerPage<PersonPosition>>(
        '/positions/',
        { person: personId, cursor: cursor ?? undefined },
        ctx,
      );
      positions.push(...positionsPage.results);
      cursor = extractCursor(positionsPage.next);
      if (!cursor) break;
    }
    data.positions = positions;
    // The caller decides what to do about a partial history, so the bound travels on the
    // payload — a short list is otherwise indistinguishable from a short career.
    data.positions_truncated = cursor !== null;
    if (cursor) {
      ctx.log.warning('Positions remain unfetched after the page walk', {
        personId,
        fetched: positions.length,
        pagesWalked: POSITION_PAGE_LIMIT,
      });
    }
    return data;
  }

  // ── Courts ────────────────────────────────────────────────────────────────

  async listCourts(
    params: {
      jurisdiction?: string | undefined;
      in_use?: boolean | undefined;
      has_opinion_scraper?: boolean | undefined;
      page?: number | undefined;
    },
    ctx: Context,
  ): Promise<{ total: number; courts: Court[]; next_cursor: string | null }> {
    const page = params.page ?? 1;
    // No page_size: `CourtViewSet` pins the plain DRF `PageNumberPagination`, which declares no
    // `page_size_query_param`, so the endpoint serves a fixed 20 rows and ignores any size asked
    // for. Sending one implies a page size upstream will never honor.
    const query: Record<string, string | number | boolean | undefined> = {
      jurisdiction: params.jurisdiction,
      in_use: params.in_use,
      has_opinion_scraper: params.has_opinion_scraper,
      page,
    };

    const data = await this.get<CourtListenerPage<Court>>('/courts/', query, ctx);
    // /courts/ is page-paginated (?page=N): `next` is a `...&page=N` URL with no cursor token —
    // signal the next page by number when upstream reports more, mirroring getDocket().
    return {
      total: data.count,
      courts: data.results,
      next_cursor: data.next ? String(page + 1) : null,
    };
  }

  // ── Oral Arguments ────────────────────────────────────────────────────────

  async searchOralArguments(
    params: {
      q: string;
      court?: string | undefined;
      argued_after?: string | undefined;
      argued_before?: string | undefined;
      page_size?: number | undefined;
      cursor?: string | undefined;
    },
    ctx: Context,
  ): Promise<{ total: number; results: AudioSearchResult[]; nextCursor: string | null }> {
    const query: Record<string, string | number | boolean | undefined> = {
      q: params.q,
      type: 'oa',
      court: params.court,
      argued_after: params.argued_after,
      argued_before: params.argued_before,
      count: params.page_size ?? 10,
      cursor: params.cursor,
    };

    const data = await this.get<CourtListenerPage<AudioSearchResult>>('/search/', query, ctx);

    return {
      total: data.count,
      results: data.results,
      nextCursor: extractCursor(data.next),
    };
  }

  // ── Citations ─────────────────────────────────────────────────────────────

  /**
   * Get opinions that cite this cluster ("cited_by" direction). The `/search/` `cites`
   * field is keyed by *opinion* ID, so the cluster's own ID matches nothing unless it
   * happens to double as one of its opinion IDs — resolve the cluster's variants first
   * and OR their IDs into one query. Paging stays on CourtListener's cursor, so the
   * count, the filters, and the pages all describe the same set.
   */
  async getCitedBy(
    params: {
      clusterId: number;
      court?: string | undefined;
      filed_after?: string | undefined;
      page_size?: number | undefined;
      cursor?: string | undefined;
    },
    ctx: Context,
  ): Promise<{
    total: number;
    results: OpinionSearchResult[];
    nextCursor: string | null;
    sourceCaseName: string | null;
  }> {
    const cluster = await this.getOpinionCluster(params.clusterId, ctx);
    const sourceCaseName = cluster.case_name ?? null;
    const opinionIds = cluster.sub_opinions.map((op) => op.id);

    if (opinionIds.length === 0) {
      return { total: 0, results: [], nextCursor: null, sourceCaseName };
    }

    const query: Record<string, string | number | boolean | undefined> = {
      q: opinionIds.map((id) => `cites:(${id})`).join(' OR '),
      type: 'o',
      court: params.court,
      filed_after: params.filed_after,
      count: params.page_size ?? 10,
      cursor: params.cursor,
    };

    const data = await this.get<CourtListenerPage<OpinionSearchResult>>('/search/', query, ctx);

    return {
      total: data.count,
      results: data.results,
      nextCursor: extractCursor(data.next),
      sourceCaseName,
    };
  }

  /**
   * Get opinions cited by this cluster ("citing" direction). Fetches cluster detail to get
   * citation IDs. `total` counts the distinct cited *opinions* before any filter, while
   * `results` are the *clusters* upstream matched under `court`/`filed_after` — several
   * cited opinions in one case collapse to a single row. The cursor walks the cited-ID
   * list rather than the filtered results, so a narrow filter can empty a page while pages
   * remain; the tool distinguishes that from "no citations" on the response.
   */
  async getCiting(
    params: {
      clusterId: number;
      court?: string | undefined;
      filed_after?: string | undefined;
      page_size?: number | undefined;
      cursor?: string | undefined;
    },
    ctx: Context,
  ): Promise<{
    total: number;
    results: OpinionSearchResult[];
    nextCursor: string | null;
    sourceCaseName: string | null;
  }> {
    const cluster = await this.getOpinionCluster(params.clusterId, ctx);
    const sourceCaseName = cluster.case_name ?? null;

    // opinions_cited are URI strings — extract numeric IDs
    const citedIds = cluster.sub_opinions
      .flatMap((op) =>
        (op.opinions_cited ?? []).flatMap((uri) => {
          const id = idFromUri(String(uri), 'opinions');
          return id !== null ? [id] : [];
        }),
      )
      .filter((id, i, arr) => arr.indexOf(id) === i);

    if (citedIds.length === 0) {
      return { total: 0, results: [], nextCursor: null, sourceCaseName };
    }

    const pageSize = params.page_size ?? 10;
    // Cursor is an offset into the already-computed cited-ID list — wire it so pages advance
    // (the IDs are all in hand; no extra upstream call needed to paginate).
    const offset = params.cursor ? parseInt(params.cursor, 10) : 0;
    const pageIds = citedIds.slice(offset, offset + pageSize);
    const query: Record<string, string | number | boolean | undefined> = {
      q: pageIds.map((id) => `id:(${id})`).join(' OR '),
      type: 'o',
      court: params.court,
      filed_after: params.filed_after,
      count: pageSize,
    };

    const data = await this.get<CourtListenerPage<OpinionSearchResult>>('/search/', query, ctx);

    return {
      total: citedIds.length,
      results: data.results,
      nextCursor: offset + pageSize < citedIds.length ? String(offset + pageSize) : null,
      sourceCaseName,
    };
  }

  // ── Citation Lookup ───────────────────────────────────────────────────────

  /**
   * Resolve every citation `/citation-lookup/` finds in the submitted text. Upstream
   * parses the text and returns one entry per citation, each with its own status and
   * candidate clusters — so this returns the whole list rather than collapsing it to a
   * first match. Court names are backfilled from each cluster's docket, bounded by
   * `maxCourtLookups` (see `COURT_BACKFILL_LIMIT`); a failed backfill leaves `court`
   * null instead of failing the lookup, which resolved fine on its own. Every cluster
   * carries a `court_resolution` saying which of those cases it is.
   */
  async lookupCitation(
    citation: string,
    maxCourtLookups: number,
    ctx: Context,
  ): Promise<CitationMatch[]> {
    type RawCluster = {
      id?: number;
      caseName?: string;
      case_name?: string;
      citation_count?: number;
      /** `Citation.volume` is a TextField upstream, so volume arrives as a string. */
      citations?: Array<{ volume: string; reporter: string; page: string }>;
      date_filed?: string;
      docket_id?: number;
      judges?: string;
      precedential_status?: string;
    };

    const result = await this.post<
      Array<{
        citation?: string;
        clusters?: RawCluster[];
        error_message?: string;
        normalized_citations?: string[];
        status?: number;
      }>
    >('/citation-lookup/', { text: citation }, ctx);

    // Upstream returns [] only when it could not parse a citation out of the text at
    // all — distinct from a parsed citation that matched nothing, which comes back as
    // an entry with status 404 and is a result, not a failure.
    if (!result || result.length === 0) {
      throw notFound(
        `No citation could be parsed from "${citation}". Supply a citation in volume-reporter-page form, for example "410 U.S. 113".`,
        { reason: 'not_found', citation },
      );
    }

    const docketIds = [
      ...new Set(
        result.flatMap((entry) =>
          (entry.clusters ?? []).flatMap((c) => (c.docket_id ? [c.docket_id] : [])),
        ),
      ),
    ];
    const { resolved, attempted } = await this.resolveCourtIdsForDockets(
      docketIds,
      maxCourtLookups,
      ctx,
    );

    return result.map((entry) => ({
      citation: entry.citation ?? '',
      clusters: (entry.clusters ?? []).map((c): CitationCluster => {
        const courtId = c.docket_id ? (resolved.get(c.docket_id) ?? null) : null;
        // Four outcomes collapse to the same null court, so name which one applies:
        // the caller's next move differs (raise the budget vs. fetch the docket vs. nothing to fetch).
        const court_resolution: CourtResolution = !c.docket_id
          ? 'no_docket'
          : courtId
            ? 'resolved'
            : attempted.has(c.docket_id)
              ? 'lookup_failed'
              : 'over_budget';
        return {
          cluster_id: c.id ?? null,
          case_name: c.caseName ?? c.case_name ?? null,
          court: courtId ? resolveCourtName(courtId) : null,
          court_id: courtId,
          court_resolution,
          date_filed: c.date_filed ?? null,
          docket_id: c.docket_id ?? null,
          citations: (c.citations ?? []).map((cit) => `${cit.volume} ${cit.reporter} ${cit.page}`),
          cite_count: c.citation_count ?? null,
          precedential_status: c.precedential_status ?? null,
          judges: c.judges ?? null,
        };
      }),
      error_message: entry.error_message ?? '',
      normalized_citation: entry.normalized_citations?.[0] ?? null,
      status: entry.status ?? 0,
    }));
  }

  /**
   * Map docket IDs to their court identifiers, one request each, bounded by `budget`.
   * A miss is non-fatal — the caller reports a null court rather than guessing one.
   *
   * Issued one at a time rather than as a `Promise.all` burst: these share the general
   * per-request throttle with everything else the caller is doing, and a 429 on the
   * first one means every sibling in flight would 429 too. Sequential lets the walk
   * stop on the first throttle instead of spending the rest of the budget learning the
   * same thing, and the dockets it never reached report `over_budget` rather than a
   * failure that never happened.
   *
   * `attempted` is the set a request was actually spent on, so the caller can tell a
   * docket that failed from one the budget never reached.
   */
  private async resolveCourtIdsForDockets(
    docketIds: number[],
    budget: number,
    ctx: Context,
  ): Promise<{ resolved: Map<number, string>; attempted: Set<number> }> {
    const resolved = new Map<number, string>();
    const attempted = new Set<number>();
    const wanted = docketIds.slice(0, budget);

    for (const docketId of wanted) {
      attempted.add(docketId);
      try {
        const summary = await this.getDocketSummary(docketId, ctx);
        if (summary.court_id) resolved.set(docketId, summary.court_id);
      } catch (err) {
        ctx.log.debug('court backfill failed', { docketId, err: String(err) });
        const reason = (err as { data?: { reason?: string } } | null)?.data?.reason;
        if (reason === 'rate_limited') {
          ctx.log.warning('Court backfill stopped on a rate limit', {
            resolved: resolved.size,
            remaining: docketIds.length - resolved.size,
          });
          break;
        }
      }
    }

    // Counts the dockets no request was spent on — the budget's surplus plus anything the
    // rate-limit break skipped, which a budget-only comparison would miss.
    if (attempted.size < docketIds.length) {
      ctx.log.warning('Court resolution bounded — clusters past the bound keep a null court', {
        dockets: docketIds.length,
        attempted: attempted.size,
        resolved: resolved.size,
      });
    }
    return { resolved, attempted };
  }

  // ── Financial Disclosures ───────────────────────────────────────────────────

  async searchFinancialDisclosures(
    params: {
      person?: number | undefined;
      page_size?: number | undefined;
      cursor?: string | undefined;
    },
    ctx: Context,
  ): Promise<{ total: number | null; results: FinancialDisclosure[]; nextCursor: string | null }> {
    // /financial-disclosures/ exposes only `person` as a filter — it rejects unknown params
    // (e.g. `year`) with a 400, so year filtering is applied client-side in the handler.
    const query: Record<string, string | number | boolean | undefined> = {
      person: params.person,
      page_size: params.page_size ?? 20,
      cursor: params.cursor,
    };

    const data = await this.get<CourtListenerPage<FinancialDisclosure>>(
      '/financial-disclosures/',
      query,
      ctx,
    );

    // This list endpoint returns `count` as a URL string unless ?count=on is set — treat non-numeric as unknown.
    const rawCount: unknown = data.count;
    return {
      total: typeof rawCount === 'number' ? rawCount : null,
      results: data.results,
      nextCursor: extractCursor(data.next),
    };
  }

  /**
   * Fetch a single financial disclosure by ID. The detail endpoint returns the
   * same shape as the list endpoint, with every line-item category inlined as an
   * array — a single upstream call yields the full itemization.
   */
  async getFinancialDisclosure(id: number, ctx: Context): Promise<FinancialDisclosure> {
    const data = await this.get<FinancialDisclosure>(`/financial-disclosures/${id}/`, {}, ctx);
    if (!data?.id) {
      throw notFound(`Financial disclosure ${id} not found.`, {
        reason: 'not_found',
        disclosureId: id,
        recovery: { hint: RECOVERY_HINTS.disclosure },
      });
    }
    return data;
  }

  // ── Parties ───────────────────────────────────────────────────────────────

  /**
   * Fetch parties and their attorneys for a docket. Two upstream calls for a typical docket:
   * 1. GET /parties/?docket=<id>&cursor=<token> — cursor-paginated, like /attorneys/
   * 2. GET /attorneys/?docket=<id> — the docket's whole attorney roster, cursor-paginated
   *
   * Attorney names and contact details require the second call — the /parties/ response
   * embeds only attorney_id, role code, and docket_id inline. Call 2 repeats (up to
   * `ATTORNEY_PAGE_LIMIT` times) only while IDs from call 1 remain unresolved.
   *
   * `cursor` is an opaque continuation token, never a page number: `PartyViewSet.ordering`
   * is `-id`, which sits in its `cursor_ordering_fields`, so v4 routes the endpoint to
   * CursorPagination. Passing a number here selects nothing and re-serves the first page.
   */
  async getParties(
    docketId: number,
    cursor: string | undefined,
    pageSize: number,
    ctx: Context,
  ): Promise<{ count: number | null; next_cursor: string | null; parties: Party[] }> {
    // Raw /parties/ shape from the upstream API
    type RawParty = {
      id: number;
      name: string;
      extra_info: string;
      party_types: PartyType[];
      attorneys: AttorneyRelationship[];
    };

    const pageData = await this.get<CourtListenerPage<RawParty>>(
      '/parties/',
      {
        docket: docketId,
        cursor,
        page_size: pageSize,
      },
      ctx,
    );

    // A /parties/ record aggregates a party's attorney relationships across EVERY docket that
    // party appears on, so a repeat litigant contributes thousands of unrelated relationships.
    // (`filter_nested_results` does not help: upstream only trims the nested rows when the
    // request carries a related-lookup key such as `docket__id`, never a plain `docket`.)
    // Scope to the requested docket before anything else — unscoped, these entries misreport
    // attorneys from other cases as counsel here.
    const scopedResults = pageData.results.map((raw) => ({
      ...raw,
      attorneys: raw.attorneys.filter((rel) => rel.docket_id === docketId),
    }));

    // Unique attorney IDs on this page — the set whose names and contact blocks need resolving.
    const allAttorneyIds = [
      ...new Set(scopedResults.flatMap((p) => p.attorneys.map((a) => a.attorney_id))),
    ];

    // Map attorney_id → detail; empty when there are no attorneys on this page.
    // `/attorneys/` has no multi-ID filter — `id` is an exact lookup, so repeated `id=` params
    // collapse to the last one and every other attorney comes back unresolved. Its `docket`
    // filter returns the roster this docket needs instead, cursor-paginated.
    const attorneyMap = new Map<number, AttorneyDetail>();
    const unresolved = new Set(allAttorneyIds);
    let attorneyCursor: string | null = null;
    for (let fetched = 0; fetched < ATTORNEY_PAGE_LIMIT && unresolved.size > 0; fetched++) {
      const attPage = await this.get<CourtListenerPage<AttorneyDetail>>(
        '/attorneys/',
        { docket: docketId, cursor: attorneyCursor ?? undefined },
        ctx,
      );
      for (const att of attPage.results) {
        if (unresolved.delete(att.id)) attorneyMap.set(att.id, att);
      }
      attorneyCursor = extractCursor(attPage.next);
      if (!attorneyCursor) break;
    }
    if (unresolved.size > 0) {
      // Say so rather than emitting blank names as if upstream had no record of them.
      ctx.log.warning('Attorney detail unresolved after the page walk', {
        docketId,
        unresolved: unresolved.size,
        pagesWalked: ATTORNEY_PAGE_LIMIT,
      });
    }

    const parties: Party[] = scopedResults.map((raw) => {
      // Derive role for this docket from party_types — pick the entry whose docket matches.
      // pt.docket arrives as a `.../dockets/<id>/` URL, so resolve it to a numeric ID first.
      const roleEntry = raw.party_types.find((pt) => toDocketId(pt.docket) === docketId);
      const role = roleEntry?.name ?? null;

      const attorneys = raw.attorneys.map((rel) => {
        const detail = attorneyMap.get(rel.attorney_id);
        return {
          attorney_id: rel.attorney_id,
          name: detail?.name ?? '',
          contact_raw: detail?.contact_raw ?? '',
          role_code: rel.role ?? null,
          role: rel.role == null ? 'Unrecorded' : expandCode(ATTORNEY_ROLE_LABELS, rel.role),
          date_action: rel.date_action ?? null,
        };
      });

      return {
        id: raw.id,
        name: raw.name ?? '',
        role,
        extra_info: raw.extra_info ?? '',
        attorneys,
      };
    });

    // /parties/ returns `count` as a URL string unless ?count=on is passed — but count=on makes
    // the endpoint drop `results`, so we request results (no count=on) and derive the total:
    // a numeric count when upstream gives one, else the exact row count when the first page is
    // also the last (no cursor in, no continuation out).
    const rawCount: unknown = pageData.count;
    const count =
      typeof rawCount === 'number'
        ? rawCount
        : pageData.next === null && cursor === undefined
          ? parties.length
          : null;

    return {
      count,
      // Cursor-paginated: `next` carries an opaque `cursor=` token, so hand that token
      // straight back — the same derivation used for /attorneys/ above.
      next_cursor: extractCursor(pageData.next),
      parties,
    };
  }

  // ── Oral Argument Detail ────────────────────────────────────────────────────

  async getOralArgument(audioId: number, ctx: Context): Promise<Audio> {
    const data = await this.get<Audio>(`/audio/${audioId}/`, {}, ctx);
    if (!data?.id) {
      throw notFound(`Oral argument ${audioId} not found.`, {
        reason: 'not_found',
        audioId,
        recovery: { hint: RECOVERY_HINTS.audio },
      });
    }
    return data;
  }
}

// ── Init/accessor pattern ─────────────────────────────────────────────────────

let _service: CourtListenerService | undefined;

export function initCourtListenerService(
  config: CourtListenerServiceConfig,
  storage: StorageService,
): void {
  _service = new CourtListenerService(config, storage);
}

export function getCourtListenerService(): CourtListenerService {
  if (!_service) {
    throw new Error(
      'CourtListenerService not initialized — call initCourtListenerService() in setup()',
    );
  }
  return _service;
}
