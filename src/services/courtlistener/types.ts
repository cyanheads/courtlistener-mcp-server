/**
 * @fileoverview Domain types for the CourtListener API client.
 * @module services/courtlistener/types
 */

/** Paginated list response envelope from the CourtListener REST API. */
export interface CourtListenerPage<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

/** Opinion search result item from the search API. */
export interface OpinionSearchResult {
  caseName: string;
  caseNameFull: string;
  citation: string[];
  citeCount: number;
  cluster_id: number;
  court: string;
  court_id: string;
  dateFiled: string;
  docket_id: number;
  docketNumber: string;
  judge: string;
  snippet: string;
  status: string;
}

/** Individual opinion variant within a cluster. */
export interface Opinion {
  author_id: number | null;
  download_url: string | null;
  html: string;
  html_with_citations?: string;
  id: number;
  /** URI strings pointing to cited opinions (e.g., ".../opinions/12345/"). */
  opinions_cited?: string[];
  per_curiam: boolean;
  plain_text: string;
  type: string;
}

/** Full opinion cluster from /clusters/{id}/. */
export interface OpinionCluster {
  caseName: string;
  caseNameFull: string;
  citation_count: number;
  citations: Array<{ volume: number; reporter: string; page: string; type: number }>;
  court: string;
  court_id?: string;
  date_filed: string;
  docket: string; // resource URI
  docket_id?: number;
  docket_number?: string;
  id: number;
  judges: string;
  posture: string;
  precedential_status: string;
  sub_opinions: Opinion[];
  syllabus: string;
}

/** Docket search result item. */
export interface DocketSearchResult {
  assignedTo: string | null;
  caseName: string;
  cause: string;
  court: string;
  court_id: string;
  dateFiled: string;
  dateTerminated: string | null;
  docket_id: number;
  docketNumber: string;
  document_count?: number;
  juryDemand: string;
  pacer_case_id: string | null;
  party_name?: string[];
  recap_documents?: Array<{
    id: number;
    description: string;
    date_filed: string;
    document_number: number | null;
    is_available: boolean;
  }>;
}

/** Full docket from /dockets/{id}/. */
export interface Docket {
  assigned_to_str: string | null;
  case_name: string;
  case_name_full: string;
  cause: string;
  court: string;
  court_id?: string;
  date_filed: string;
  date_terminated: string | null;
  docket_entries: DocketEntry[];
  /** Total entry count from /docket-entries/?docket=... — may exceed the fetched page. */
  docket_entries_count?: number;
  docket_number: string;
  id: number;
  jurisdiction_type: string;
  jury_demand: string;
  pacer_case_id: string | null;
  referred_to_str: string | null;
}

/** A single docket entry. */
export interface DocketEntry {
  date_filed: string;
  description: string;
  entry_number: number | null;
  id: number;
  recap_documents: Array<{
    id: number;
    document_number: number | null;
    attachment_number: number | null;
    description: string;
    is_available: boolean;
    page_count: number | null;
    filepath_local: string | null;
  }>;
}

/** Person/judge search result. */
export interface PersonSearchResult {
  aba_rating: string[];
  appointer: string | null;
  court: string | null;
  court_id: string | null;
  date_start: string | null;
  dob: string | null;
  dob_city: string | null;
  dob_state: string | null;
  gender: string;
  id: number; // person_id
  name: string;
  political_affiliation: string[];
  position_type: string | null;
  school: string[];
}

/** Full person/judge record from /people/{id}/. */
export interface Person {
  /** Inline objects with rating codes (e.g., "q", "wq"). */
  aba_ratings: Array<{ rating: string; year_rated: number | null }>;
  date_dob: string | null;
  date_dod: string | null;
  dob_city: string | null;
  dob_state: string | null;
  educations: Array<{
    school: { name: string };
    degree_level: string | null;
    graduation_year: number | null;
  }>;
  /** Integer ID for FJC cross-referencing; null if not available. */
  fjc_id: number | null;
  gender: string;
  id: number;
  name_first: string | null;
  /** name_full is null on the /people/ endpoint — build from name_first/name_last. */
  name_full: string | null;
  name_last: string | null;
  /** Inline objects with party codes (e.g., "r", "d"). */
  political_affiliations: Array<{
    political_party: string;
    date_start: string | null;
    date_end: string | null;
  }>;
  /** Populated by a separate /positions/?person={id} call — URI strings on /people/{id}/. */
  positions: PersonPosition[];
}

/** Position record from /positions/?person={id}. */
export interface PersonPosition {
  /** URI string for the appointing position; null if not applicable. */
  appointer: string | null;
  /** Nested court object with id, full_name, short_name; null if not a judicial position. */
  court: { id: string; full_name: string; short_name: string } | null;
  date_confirmation: string | null;
  date_nominated: string | null;
  date_start: string | null;
  date_termination: string | null;
  how_selected: string | null;
  nomination_process: string | null;
  position_type: string | null;
  termination_reason: string | null;
}

/** Court record from /courts/. */
export interface Court {
  citation_string: string;
  full_name: string;
  has_opinion_scraper: boolean;
  has_oral_argument_scraper: boolean;
  id: string;
  in_use: boolean;
  jurisdiction: string;
  short_name: string;
}

/** Oral argument audio search result. */
export interface AudioSearchResult {
  caseName: string;
  court: string;
  court_id: string;
  dateArgued: string | null;
  docket_id: number;
  docketNumber: string;
  download_url: string | null;
  duration: number;
  id: number; // audio_id
  judge: string;
  local_path: string | null;
  panel_ids: number[];
  snippet: string;
}

/** Citation lookup response from /citation-lookup/. */
export interface CitationLookupResult {
  case_name: string | null;
  citations: string[];
  cluster_id: number | null;
  court: string | null;
  date_filed: string | null;
  normalized_citation: string | null;
}
