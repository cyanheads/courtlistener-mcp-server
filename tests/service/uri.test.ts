/**
 * @fileoverview Tests for the CourtListener resource-URI ID extraction helper.
 * @module tests/service/uri.test
 */

import { describe, expect, it } from 'vitest';
import { idFromUri, personIdFromUri } from '@/services/courtlistener/uri.js';

describe('idFromUri', () => {
  it('extracts the numeric id from a full resource URI', () => {
    expect(idFromUri('https://www.courtlistener.com/api/rest/v4/people/1234/', 'people')).toBe(
      1234,
    );
    expect(idFromUri('https://www.courtlistener.com/api/rest/v4/dockets/5578727/', 'dockets')).toBe(
      5578727,
    );
    expect(idFromUri('/api/rest/v4/opinions/999/', 'opinions')).toBe(999);
  });

  it('returns null when the collection segment is absent', () => {
    // A URI for a different collection does not match.
    expect(idFromUri('https://www.courtlistener.com/api/rest/v4/dockets/42/', 'people')).toBeNull();
    // A bare numeric string has no `/collection/id/` segment.
    expect(idFromUri('5578727', 'dockets')).toBeNull();
    expect(idFromUri('', 'people')).toBeNull();
  });

  it('requires the trailing slash after the id (matches CourtListener URI shape)', () => {
    // CourtListener always terminates resource URIs with a slash; a missing one does not match.
    expect(idFromUri('/api/rest/v4/people/1234', 'people')).toBeNull();
  });

  it('extracts the first id when the collection segment appears', () => {
    expect(
      idFromUri(
        'https://www.courtlistener.com/api/rest/v3/disclosure-positions/99105/',
        'disclosure-positions',
      ),
    ).toBe(99105);
  });
});

describe('personIdFromUri', () => {
  it('extracts the person id from a /people/{id}/ URI', () => {
    expect(personIdFromUri('https://www.courtlistener.com/api/rest/v4/people/3045/')).toBe(3045);
  });

  it('returns null for a non-person URI or empty string', () => {
    expect(personIdFromUri('https://www.courtlistener.com/api/rest/v4/audio/77/')).toBeNull();
    expect(personIdFromUri('')).toBeNull();
  });
});
