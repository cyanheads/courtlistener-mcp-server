/**
 * @fileoverview Extract numeric resource IDs from CourtListener hyperlinked
 * resource URIs. The REST API serializes cross-resource references as
 * `.../{collection}/{id}/` URLs (e.g. a disclosure's filer as
 * `.../people/1234/`); the tools chain by pulling the numeric key back out.
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
