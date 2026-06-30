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
  /** Upstream returns snake_case `case_name` — not the camelCase form the search API uses. */
  case_name: string;
  case_name_full: string;
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
    /**
     * PACER document number. The /docket-entries/ endpoint serializes this as a
     * string ("1"); attachments can be non-integer ("70-1"). (The /search/ endpoint
     * returns it as an int — see DocketSearchResult.)
     */
    document_number: number | string | null;
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

/** A single gift line item embedded in a financial disclosure. */
export interface FinancialGift {
  description: string;
  source: string;
  /** Pre-formatted dollar string (e.g., "$6,580.00"); empty when not reported. */
  value: string;
}

/**
 * Judicial financial disclosure from /financial-disclosures/.
 * Line-item categories (investments, debts, positions, etc.) arrive inline as
 * arrays — investments can run to hundreds of coded entries per filing, so the
 * tool surfaces category counts plus the linked PDF rather than the raw rows.
 */
export interface FinancialDisclosure {
  agreements: unknown[];
  debts: unknown[];
  /** URL to the source disclosure PDF on CourtListener; null if unavailable. */
  filepath: string | null;
  gifts: FinancialGift[];
  has_been_extracted: boolean;
  id: number;
  investments: unknown[];
  is_amended: boolean;
  non_investment_incomes: unknown[];
  page_count: number | null;
  /** Resource URI for the filer — extract the person id and chain to get_judge. */
  person: string;
  positions: unknown[];
  reimbursements: unknown[];
  /** Report-type code (-1 unknown, 0 nomination, 1 initial, 2 annual, 3 final). */
  report_type: number;
  spouse_incomes: unknown[];
  year: number;
}

/** Role entry for a party within a specific docket — party_types[] from /parties/. */
export interface PartyType {
  /** Docket this role applies to — a `.../dockets/<id>/` URL from /parties/, or a numeric ID/string. */
  docket: number | string;
  /** Role name for this docket, e.g. "Plaintiff", "Defendant", "Petitioner", "Respondent". */
  name: string;
}

/** Attorney–party relationship from the /parties/ response (embedded in party's attorneys[]). */
export interface AttorneyRelationship {
  /** Numeric attorney ID — pass to /attorneys/{id}/ for name and contact. */
  attorney_id: number;
  /** Docket this relationship applies to. */
  docket_id: number;
  /** Numeric role code from the party–attorney relationship (e.g. 1 = "Lead attorney"). */
  role: number;
}

/** Attorney detail from /attorneys/{id}/. */
export interface AttorneyDetail {
  /** Free-text address/phone block as returned by the API. */
  contact_raw: string;
  /** Email address if separately recorded; empty string if not. */
  email: string;
  /** Fax number if separately recorded; empty string if not. */
  fax: string;
  /** Attorney person ID. */
  id: number;
  /** Attorney display name. */
  name: string;
  /** Phone number if separately recorded; empty string if not. */
  phone: string;
}

/** A party and their attorneys for a docket, assembled from /parties/ + /attorneys/. */
export interface Party {
  /** Attorneys of record for this party on this docket. */
  attorneys: {
    attorney_id: number;
    name: string;
    contact_raw: string;
    role_code: number;
  }[];
  /** Additional metadata from upstream (e.g., pro se status, date range). */
  extra_info: string;
  /** Upstream party record ID. */
  id: number;
  /** Party display name (e.g., "Jane Doe", "Acme Corporation"). */
  name: string;
  /** Role for this docket derived from party_types[].name (e.g., "Plaintiff", "Defendant"); null if unavailable. */
  role: string | null;
}

/** Full oral argument audio record from /audio/{id}/. */
export interface Audio {
  case_name: string;
  case_name_full: string;
  /** Resource URI for the docket — extract the id and chain to get_docket. */
  docket: string;
  download_url: string | null;
  duration: number;
  id: number;
  /** Free-text judge names; frequently empty on this endpoint. */
  judges: string;
  /** Person ids of the panel; pass to get_judge. */
  panel: number[];
  source: string;
  stt_status: number;
  /** Speech-to-text transcript; empty until transcription completes. */
  stt_transcript: string;
}
