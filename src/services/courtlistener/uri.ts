/**
 * @fileoverview CourtListener URL and path helpers. The REST API serializes
 * cross-resource references as `.../{collection}/{id}/` URLs (e.g. a disclosure's
 * filer as `.../people/1234/`) and stored files as bare relative paths; the tools
 * chain by pulling the numeric key back out, and resolve paths to fetchable URLs.
 * @module services/courtlistener/uri
 */

/**
 * Extract the numeric ID from a CourtListener resource URI of the form
 * `.../{collection}/{id}/`. Returns null when the URI is empty or has no
 * `/{collection}/{digits}/` segment (e.g. a bare numeric string, or a URI for a
 * different collection). `collection` is an internal literal (`people`,
 * `dockets`, `opinions`), never user input.
 *
 * @example
 * idFromUri('https://www.courtlistener.com/api/rest/v4/people/1234/', 'people') // 1234
 * idFromUri('12345', 'dockets') // null
 */
export function idFromUri(uri: string, collection: string): number | null {
  const match = uri.match(new RegExp(`/${collection}/(\\d+)/`));
  return match?.[1] ? parseInt(match[1], 10) : null;
}

/** Extract the person ID from a `/people/{id}/` resource URI; null if absent. */
export function personIdFromUri(uri: string): number | null {
  return idFromUri(uri, 'people');
}

/**
 * Resolve a CourtListener stored-file path to a directly fetchable URL. The API
 * serves `filepath_local` (RECAP documents) and `local_path` (opinion PDFs, oral
 * argument MP3s) as bare relative paths rooted at the storage bucket. Absolute
 * URLs pass through unchanged; empty or absent values yield null.
 *
 * @example
 * toStorageUrl('mp3/2026/03/30/case.mp3') // 'https://storage.courtlistener.com/mp3/2026/03/30/case.mp3'
 * toStorageUrl('https://storage.courtlistener.com/x.pdf') // unchanged
 * toStorageUrl(null) // null
 */
export function toStorageUrl(path: string | null): string | null {
  if (!path) return null;
  return /^https?:\/\//.test(path) ? path : `https://storage.courtlistener.com/${path}`;
}
