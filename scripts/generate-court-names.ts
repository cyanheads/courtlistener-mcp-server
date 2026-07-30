#!/usr/bin/env bun
/**
 * @fileoverview Regenerates `src/services/courtlistener/court-names-data.ts` — the bundled
 * snapshot of every CourtListener court — by paging the public `/courts/` endpoint.
 *
 * Why a snapshot exists: `CourtViewSet` pins DRF's plain `PageNumberPagination`, which
 * declares no `page_size_query_param`, so the endpoint serves a fixed 20 rows per page and
 * ignores any size asked for. Enumerating all ~3,400 courts is therefore ~170 sequential
 * requests — more than a day's published free-tier allowance. Resolving a court id to a
 * name, or listing what courts exist, has to be local or it cannot happen at all.
 *
 * `/courts/` serves unauthenticated, so this spends no API token quota. Requests are paced
 * and issued one at a time. The file is written only after every page has been fetched, so
 * a failed run leaves the previous snapshot intact rather than a half-written one. Rows are
 * sorted by id and rendered deterministically, so a run over unchanged upstream data
 * reproduces the same bytes apart from `COURT_SNAPSHOT_DATE`.
 *
 * @example
 * // Regenerate the snapshot in place:
 * // bun run courts:snapshot
 *
 * @example
 * // Fetch and report without writing, with a slower pace:
 * // bun run scripts/generate-court-names.ts --dry-run --delay=800
 *
 * @module scripts/generate-court-names
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const COURTS_URL = 'https://www.courtlistener.com/api/rest/v4/courts/';
const OUT_PATH = resolve(import.meta.dir, '../src/services/courtlistener/court-names-data.ts');
const DEFAULT_DELAY_MS = 400;
const MAX_ATTEMPTS = 4;

/** The fields of a `/courts/` row the snapshot keeps. */
interface CourtRow {
  full_name: string | null;
  has_opinion_scraper: boolean | null;
  id: string;
  in_use: boolean | null;
  jurisdiction: string | null;
}

interface CourtsPage {
  count: number;
  next: string | null;
  results: CourtRow[];
}

function flag(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return;
  return hit.includes('=') ? hit.slice(hit.indexOf('=') + 1) : '';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch one page, retrying on transient failure. A 429 means the shared per-IP window is
 * spent, so back off far longer than a network blip warrants.
 */
async function fetchPage(url: string, delayMs: number): Promise<CourtsPage> {
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'courtlistener-mcp-server court-snapshot generator',
      },
    });
    if (response.ok) return (await response.json()) as CourtsPage;

    lastError = `HTTP ${response.status} ${response.statusText}`;
    const retryAfter = Number(response.headers.get('retry-after'));
    const backoff = response.status === 429 ? (retryAfter || 60) * 1000 : delayMs * 2 ** attempt;
    if (attempt < MAX_ATTEMPTS) {
      console.warn(`  ${lastError} on ${url} — retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
    }
  }
  throw new Error(`Gave up on ${url} after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

/** Walk `?page=N` to the end. `next` is a page URL, so follow it rather than counting. */
async function fetchAllCourts(delayMs: number): Promise<CourtRow[]> {
  const courts: CourtRow[] = [];
  let url: string | null = `${COURTS_URL}?page=1`;
  let page = 0;

  while (url) {
    page++;
    const data: CourtsPage = await fetchPage(url, delayMs);
    courts.push(...data.results);
    if (page === 1 || page % 20 === 0 || !data.next) {
      console.log(`  page ${page}: ${courts.length}/${data.count} courts`);
    }
    url = data.next;
    if (url) await sleep(delayMs);
  }
  return courts;
}

/** Quote a string the way Biome's `quoteStyle: single` would. */
function str(value: string): string {
  return value.includes("'") && !value.includes('"')
    ? JSON.stringify(value)
    : `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** Bare key when it is a valid identifier, quoted otherwise. */
function key(id: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id) ? id : str(id);
}

function render(courts: CourtRow[], generatedOn: string): string {
  const sorted = [...courts].sort((a, b) => a.id.localeCompare(b.id));
  const inUse = sorted.filter((c) => c.in_use).length;

  const names = sorted.map((c) => `  ${key(c.id)}: ${str(c.full_name ?? c.id)},`).join('\n');
  const attributes = sorted
    .map(
      (c) =>
        `  ${key(c.id)}: { jurisdiction: ${str(c.jurisdiction ?? '')}, in_use: ${c.in_use === true}, has_opinion_scraper: ${c.has_opinion_scraper === true} },`,
    )
    .join('\n');

  return `/**
 * @fileoverview Generated snapshot of every CourtListener court — ${sorted.length} rows,
 * ${inUse} of them in use. Court-name resolution and full enumeration stay local and cost
 * no request, which is what makes them possible at all: \`/courts/\` serves a fixed 20 rows
 * per page and ignores \`page_size\`, so reading the whole list is ~${Math.ceil(sorted.length / 20)} sequential requests
 * against a published free-tier ceiling of 125/day. Values are verbatim from the API.
 *
 * Do not hand-edit. Regenerate with \`bun run courts:snapshot\` when CourtListener adds,
 * renames, or retires courts — court records change rarely, which is what makes a snapshot
 * viable, so an occasional refresh alongside other maintenance is enough.
 * @module services/courtlistener/court-names-data
 */

/** Date this snapshot was taken from \`/courts/\` (UTC, ISO 8601 date). */
export const COURT_SNAPSHOT_DATE = '${generatedOn}';

/** CourtListener court id -> official \`full_name\`, for every court, active or not. */
export const COURT_FULL_NAMES: Record<string, string> = {
${names}
};

/**
 * Per-court facts the snapshot carries beyond the name, keyed by the same ids as
 * \`COURT_FULL_NAMES\`. \`in_use\` distinguishes the bench CourtListener still scrapes from
 * the historical and defunct courts it does not; \`jurisdiction\` and \`has_opinion_scraper\`
 * mirror the \`courtlistener_lookup_courts\` filters so the same question can be answered
 * offline.
 */
export const COURT_ATTRIBUTES: Record<
  string,
  { jurisdiction: string; in_use: boolean; has_opinion_scraper: boolean }
> = {
${attributes}
};
`;
}

async function main(): Promise<void> {
  // A mistyped --delay would otherwise parse to NaN and pace every one of ~170 requests
  // at zero, hammering a public endpoint on a typo.
  const requested = Number(flag('delay'));
  const delayMs = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_DELAY_MS;
  const dryRun = flag('dry-run') !== undefined;

  console.log(`Fetching every CourtListener court from ${COURTS_URL} (${delayMs}ms apart)…`);
  const courts = await fetchAllCourts(delayMs);

  const ids = new Set(courts.map((c) => c.id));
  if (ids.size !== courts.length) {
    throw new Error(`Duplicate court ids in the response: ${courts.length} rows, ${ids.size} ids`);
  }

  const generatedOn = new Date().toISOString().slice(0, 10);
  const source = render(courts, generatedOn);

  if (dryRun) {
    console.log(`Dry run — ${courts.length} courts, ${source.length} bytes, nothing written.`);
    return;
  }

  writeFileSync(OUT_PATH, source, 'utf8');
  // Emitted source is close to Biome's output but not guaranteed identical (long names
  // wrap). Normalize it so a regenerated file is byte-stable and devcheck stays quiet.
  execFileSync(resolve(import.meta.dir, '../node_modules/.bin/biome'), [
    'format',
    '--write',
    OUT_PATH,
  ]);
  console.log(`Wrote ${courts.length} courts to ${OUT_PATH}`);
}

await main();
