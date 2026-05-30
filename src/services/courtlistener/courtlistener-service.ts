/**
 * @fileoverview CourtListener REST API v4 client service. Handles auth, retry,
 * rate-limit classification, and response normalization for all tools.
 * @module services/courtlistener/courtlistener-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound, rateLimited, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  AudioSearchResult,
  CitationLookupResult,
  Court,
  CourtListenerPage,
  Docket,
  DocketEntry,
  DocketSearchResult,
  Opinion,
  OpinionCluster,
  OpinionSearchResult,
  Person,
  PersonPosition,
  PersonSearchResult,
} from './types.js';

const REQUEST_TIMEOUT_MS = 30_000;

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

/** Classify the rate-limit window from headers or response body. */
function buildRateLimitMessage(retryAfter: string | null): string {
  const base = 'CourtListener rate limit reached.';
  const hint =
    'Free tier: 5 req/min, 50/hr, 125/day. Check courtlistener.com for membership options.';
  if (retryAfter) {
    return `${base} Retry-After: ${retryAfter}s. ${hint}`;
  }
  return `${base} ${hint}`;
}

export class CourtListenerService {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: AppConfig, _storage: StorageService) {
    const cfg = config as unknown as { baseUrl?: string; apiToken?: string };
    this.baseUrl = cfg.baseUrl ?? 'https://www.courtlistener.com/api/rest/v4';
    this.token = cfg.apiToken ?? '';
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Token ${this.token}`,
      Accept: 'application/json',
      'User-Agent': 'courtlistener-mcp-server/0.1.2',
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
      if (v !== undefined && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
    const fullUrl = url.toString();
    ctx.log.debug('CourtListener GET', { url: fullUrl });

    // biome-ignore lint/suspicious/noExplicitAny: Context satisfies RequestContext at runtime
    const reqCtx = ctx as unknown as any;

    return withRetry(
      async () => {
        const response = await fetchWithTimeout(fullUrl, REQUEST_TIMEOUT_MS, reqCtx, {
          signal: ctx.signal,
          headers: this.headers(),
        });

        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          throw rateLimited(buildRateLimitMessage(retryAfter), {
            reason: 'rate_limited',
            ...(retryAfter && { retryAfter }),
          });
        }

        if (response.status === 404) {
          throw notFound(`Resource not found: ${path}`, { path });
        }

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          if (/^\s*<(!DOCTYPE|html)/i.test(body)) {
            throw serviceUnavailable(
              `CourtListener returned HTML (status ${response.status}) — likely a maintenance window or error page.`,
            );
          }
          throw serviceUnavailable(`CourtListener API error: HTTP ${response.status} for ${path}`, {
            status: response.status,
            body: body.slice(0, 200),
          });
        }

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
        const response = await fetchWithTimeout(fullUrl, REQUEST_TIMEOUT_MS, reqCtx, {
          method: 'POST',
          signal: ctx.signal,
          headers: { ...this.headers(), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          throw rateLimited(buildRateLimitMessage(retryAfter), {
            reason: 'rate_limited',
            ...(retryAfter && { retryAfter }),
          });
        }

        if (response.status === 404) {
          throw notFound('Citation not found in CourtListener database.', {
            reason: 'not_found',
          });
        }

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          throw serviceUnavailable(`CourtListener API error: HTTP ${response.status}`, {
            status: response.status,
            body: text.slice(0, 200),
          });
        }

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
      });
    }
    // /clusters/{id}/ returns sub_opinions as URI strings — fetch the actual opinion objects
    const opinions = await this.get<CourtListenerPage<Opinion>>(
      '/opinions/',
      { cluster: clusterId, page_size: 20 },
      ctx,
    );
    data.sub_opinions = opinions.results;
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

  async getDocket(docketId: number, entriesPageSize: number, ctx: Context): Promise<Docket> {
    const data = await this.get<Docket>(`/dockets/${docketId}/`, {}, ctx);
    if (!data?.id) {
      throw notFound(`Docket ${docketId} not found.`, { reason: 'not_found', docketId });
    }
    // /dockets/{id}/ does not include docket_entries — fetch separately from /docket-entries/
    const entries = await this.get<CourtListenerPage<DocketEntry>>(
      '/docket-entries/',
      { docket: docketId, page_size: entriesPageSize, order_by: 'entry_number' },
      ctx,
    );
    data.docket_entries = entries.results;
    data.docket_entries_count = entries.count;
    return data;
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
      throw notFound(`Person ${personId} not found.`, { reason: 'not_found', personId });
    }
    // /people/{id}/ returns positions as URI strings — fetch actual position objects separately
    const positionsPage = await this.get<CourtListenerPage<PersonPosition>>(
      '/positions/',
      { person: personId, page_size: 50 },
      ctx,
    );
    data.positions = positionsPage.results;
    return data;
  }

  // ── Courts ────────────────────────────────────────────────────────────────

  async listCourts(
    params: {
      jurisdiction?: string | undefined;
      in_use?: boolean | undefined;
      has_opinion_scraper?: boolean | undefined;
    },
    ctx: Context,
  ): Promise<{ total: number; courts: Court[] }> {
    const query: Record<string, string | number | boolean | undefined> = {
      jurisdiction: params.jurisdiction,
      in_use: params.in_use,
      has_opinion_scraper: params.has_opinion_scraper,
      page_size: 500,
    };

    const data = await this.get<CourtListenerPage<Court>>('/courts/', query, ctx);
    return { total: data.count, courts: data.results };
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

  /** Get opinions that cite this cluster ("cited_by" direction). */
  async getCitedBy(
    params: {
      clusterId: number;
      court?: string | undefined;
      filed_after?: string | undefined;
      page_size?: number | undefined;
      cursor?: string | undefined;
    },
    ctx: Context,
  ): Promise<{ total: number; results: OpinionSearchResult[]; nextCursor: string | null }> {
    const query: Record<string, string | number | boolean | undefined> = {
      q: `cites:(${params.clusterId})`,
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
    };
  }

  /** Get opinions cited by this cluster ("citing" direction). Fetches cluster detail to get citation IDs. */
  async getCiting(
    params: {
      clusterId: number;
      court?: string | undefined;
      filed_after?: string | undefined;
      page_size?: number | undefined;
      cursor?: string | undefined;
    },
    ctx: Context,
  ): Promise<{ total: number; results: OpinionSearchResult[]; nextCursor: string | null }> {
    const cluster = await this.getOpinionCluster(params.clusterId, ctx);

    // opinions_cited are URI strings — extract numeric IDs
    const citedIds = cluster.sub_opinions
      .flatMap((op) =>
        (op.opinions_cited ?? []).flatMap((uri) => {
          const match = String(uri).match(/\/opinions\/(\d+)\//);
          return match?.[1] ? [parseInt(match[1], 10)] : [];
        }),
      )
      .filter((id, i, arr) => arr.indexOf(id) === i);

    if (citedIds.length === 0) {
      return { total: 0, results: [], nextCursor: null };
    }

    const pageSize = params.page_size ?? 10;
    const pageIds = citedIds.slice(0, pageSize);
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
      nextCursor: citedIds.length > pageSize ? String(pageSize) : null,
    };
  }

  // ── Citation Lookup ───────────────────────────────────────────────────────

  async lookupCitation(citation: string, ctx: Context): Promise<CitationLookupResult> {
    // API expects a single JSON object, not an array
    const result = await this.post<
      Array<{
        citation?: string;
        normalized_citations?: string[];
        clusters?: Array<{
          id?: number;
          caseName?: string;
          case_name?: string;
          court?: string;
          date_filed?: string;
          citations?: Array<{ volume: string; reporter: string; page: string }>;
        }>;
      }>
    >('/citation-lookup/', { text: citation }, ctx);

    if (!result || result.length === 0) {
      throw notFound(`Citation "${citation}" not found in CourtListener database.`, {
        reason: 'not_found',
        citation,
      });
    }

    // biome-ignore lint/style/noNonNullAssertion: length checked above
    const first = result[0]!;
    const cluster = first.clusters?.[0];

    if (!cluster) {
      throw notFound(`Citation "${citation}" not found in CourtListener database.`, {
        reason: 'not_found',
        citation,
      });
    }

    return {
      cluster_id: cluster.id ?? null,
      case_name: cluster.caseName ?? cluster.case_name ?? null,
      court: cluster.court ?? null,
      date_filed: cluster.date_filed ?? null,
      citations: (cluster.citations ?? []).map((c) => `${c.volume} ${c.reporter} ${c.page}`),
      normalized_citation: first.normalized_citations?.[0] ?? null,
    };
  }
}

// ── Init/accessor pattern ─────────────────────────────────────────────────────

let _service: CourtListenerService | undefined;

export function initCourtListenerService(config: AppConfig, storage: StorageService): void {
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
