/**
 * @fileoverview Tests for the CourtListener URI/path helpers.
 * @module tests/service/uri.test
 */

import { describe, expect, it } from 'vitest';
import { idFromUri, personIdFromUri, toStorageUrl } from '@/services/courtlistener/uri.js';

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

// #53 — local_path/filepath_local arrive as bare relative paths; unresolved they
// are unusable, so every caller routes them through this helper.
describe('toStorageUrl', () => {
  it('prefixes a bare relative path with the storage host', () => {
    expect(toStorageUrl('mp3/2026/03/30/abouammo_v._united_states_cl_8.mp3')).toBe(
      'https://storage.courtlistener.com/mp3/2026/03/30/abouammo_v._united_states_cl_8.mp3',
    );
    expect(toStorageUrl('pdf/2017/12/06/statutes_severability.pdf')).toBe(
      'https://storage.courtlistener.com/pdf/2017/12/06/statutes_severability.pdf',
    );
    expect(toStorageUrl('recap/gov.uscourts.ilnb.1105257/gov.uscourts.ilnb.1105257.1.0.pdf')).toBe(
      'https://storage.courtlistener.com/recap/gov.uscourts.ilnb.1105257/gov.uscourts.ilnb.1105257.1.0.pdf',
    );
  });

  it('passes an already-absolute URL through unchanged', () => {
    expect(toStorageUrl('https://storage.courtlistener.com/mp3/case.mp3')).toBe(
      'https://storage.courtlistener.com/mp3/case.mp3',
    );
    expect(toStorageUrl('http://www.supremecourt.gov/media/audio/mp3files/25-5146.mp3')).toBe(
      'http://www.supremecourt.gov/media/audio/mp3files/25-5146.mp3',
    );
  });

  it('returns null for an absent or empty path', () => {
    expect(toStorageUrl(null)).toBeNull();
    expect(toStorageUrl('')).toBeNull();
  });
});
