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

/**
 * A single opinion variant nested inside an opinion search result. `/search/?type=o`
 * returns one row per *cluster*, with every opinion filed in that case nested under
 * `opinions[]` — and the matched excerpt lives here, not on the cluster row.
 */
export interface OpinionSearchVariant {
  author_id: number | null;
  /** Opinion IDs this variant cites — the same index the `cites:` query field keys on. */
  cites: number[];
  download_url: string | null;
  id: number;
  /** Relative storage path (e.g. "pdf/2017/12/06/….pdf"); null when not stored. */
  local_path: string | null;
  per_curiam: boolean;
  /** Matched text excerpt for this variant; empty when the match carried none. */
  snippet: string;
  /** Label-expanded by the search API (e.g. "combined-opinion"); `/opinions/` serves the raw code ("010combined"). */
  type: string;
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
  /** Per-variant opinion rows. The matched `snippet` is on these, never on the cluster row. */
  opinions: OpinionSearchVariant[];
  status: string;
}

/** Individual opinion variant within a cluster. */
export interface Opinion {
  author_id: number | null;
  download_url: string | null;
  /**
   * Opinion text variants. CourtListener populates a different field depending
   * on the import source — `html`/`plain_text` are often empty for pre-2000 case
   * law, while `html_with_citations` (and `xml_harvard`) carry the full text.
   */
  html: string;
  html_anon_2020?: string;
  html_columbia?: string;
  html_lawbox?: string;
  html_with_citations?: string;
  id: number;
  /** URI strings pointing to cited opinions (e.g., ".../opinions/12345/"). */
  opinions_cited?: string[];
  per_curiam: boolean;
  plain_text: string;
  type: string;
  xml_harvard?: string;
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

/**
 * Docket search result item from `/search/?type=r`. Note the response carries no
 * document total — `recap_documents` is a small sample of matched entries, not the
 * docket's full filing list (use courtlistener_get_docket for that).
 */
export interface DocketSearchResult {
  assignedTo: string | null;
  /** Attorney names of record on this docket. */
  attorney?: string[];
  case_name_full?: string;
  caseName: string;
  cause: string;
  court: string;
  court_id: string;
  dateFiled: string;
  dateTerminated: string | null;
  docket_id: number;
  docketNumber: string;
  /** Law firm names of record on this docket. */
  firm?: string[];
  jurisdictionType?: string;
  juryDemand: string;
  pacer_case_id: string | null;
  /** Party names. `party_name` is the *input* filter; the response key is `party`. */
  party?: string[];
  recap_documents?: Array<{
    id: number;
    description: string;
    document_number: number | null;
    document_type?: string;
    /** Date the parent docket entry was filed — the response has no `date_filed`. */
    entry_date_filed?: string;
    entry_number?: number | null;
    /** Relative RECAP storage path; null when no copy is stored. */
    filepath_local?: string | null;
    is_available: boolean;
    page_count?: number | null;
  }>;
  referredTo?: string | null;
  /** Nature-of-suit label, usually code-prefixed (e.g. "830 Patent"); empty for non-civil dockets. */
  suitNature?: string;
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
  /**
   * Next page number to fetch from /docket-entries/?docket=...&page=N; null when the fetched
   * page is the last. /docket-entries/ is page-paginated (its `next` is a `...&page=N` URL, not a
   * cursor token), so this is populated as a stringified page number — set the same way
   * docket_entries_count is, from the /docket-entries/ response.
   */
  docket_entries_next_page?: string | null;
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

/**
 * A position row nested inside a person search result. Unlike `PersonPosition`
 * (from `/positions/`), every coded column here arrives already label-expanded —
 * `selection_method` is "Appointment (President)", not "a_pres" — and `appointer`
 * is the appointing president's name, not a resource URI.
 */
export interface PersonSearchPosition {
  appointer: string | null;
  /** Court ID (e.g. "scotus"); null for non-judicial positions. */
  court_exact: string | null;
  court_full_name: string | null;
  date_start: string | null;
  /** Null while the judge still holds the position. */
  date_termination: string | null;
  /** Free-text title for non-judicial roles (e.g. "Assistant district attorney"); '' otherwise. */
  job_title: string | null;
  /** Employer for non-judicial roles; null or '' otherwise. */
  organization_name: string | null;
  position_type: string | null;
  selection_method: string | null;
  /** Expanded label (e.g. "Appointed to Other Judgeship"); '' when still serving. */
  termination_reason: string | null;
}

/** Person/judge search result. */
export interface PersonSearchResult {
  /** Expanded ABA rating labels (e.g. "Well Qualified"), not the rating codes. */
  aba_rating: string[];
  dob: string | null;
  dob_city: string | null;
  dob_state: string | null;
  gender: string;
  id: number; // person_id
  name: string;
  /** Expanded party labels (e.g. "Democratic"); the codes are on `political_affiliation_id`. */
  political_affiliation: string[];
  /** Every position the person has held. Court and appointment data live only here. */
  positions: PersonSearchPosition[];
  school: string[];
}

/** Full person/judge record from /people/{id}/. */
export interface Person {
  /** Inline objects with rating codes (e.g., "q", "wq"). */
  aba_ratings: Array<{ rating: string; year_rated: number | null }>;
  date_dob: string | null;
  date_dod: string | null;
  /**
   * Precision CourtListener actually recorded for `date_dob`, as a strftime
   * format string — `"%Y"`, `"%Y-%m"`, or `"%Y-%m-%d"`; `""` when unset. A
   * year-only record is stored as `YYYY-01-01`, so the month and day of
   * `date_dob` are placeholders unless this says `"%Y-%m-%d"`.
   */
  date_granularity_dob: string | null;
  /** Precision recorded for `date_dod`; same three values as `date_granularity_dob`. */
  date_granularity_dod: string | null;
  dob_city: string | null;
  dob_state: string | null;
  educations: Array<{
    school: { name: string };
    degree_level: string | null;
    /** Year the degree was awarded. Upstream's column is `degree_year`; there is no `graduation_year`. */
    degree_year: number | null;
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
  /**
   * Precision recorded for `date_start` — the same three strftime values as
   * `Person.date_granularity_dob`, `""` when unset. A year-only start date is
   * stored as `YYYY-01-01`, so the month and day are placeholders.
   */
  date_granularity_start: string | null;
  /** Precision recorded for `date_termination`; same three values. */
  date_granularity_termination: string | null;
  date_nominated: string | null;
  date_start: string | null;
  date_termination: string | null;
  how_selected: string | null;
  /**
   * Free-text title for a role that has no `position_type` code (e.g. "Assistant
   * district attorney"). Upstream's own guidance is that `position_type` "may be
   * blank if job_title is complete instead", so a non-judicial row carries its
   * only description here; `''` on judicial rows.
   */
  job_title: string | null;
  nomination_process: string | null;
  /** Employer for a non-judicial role; `''` or null when the row has a `court`. */
  organization_name: string | null;
  /** Coded position type (e.g. "jud"); null for non-judicial rows — see `job_title`. */
  position_type: string | null;
  /** Coded termination reason (e.g. "other_pos"); `''` while still serving. */
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
 * Line-item category shapes from /financial-disclosures/{id}/. Each category
 * arrives inline as an array of these rows. Only the fields the detail tool
 * surfaces are declared; extraction metadata (resource_uri, timestamps,
 * back-references) is omitted. Coded columns (income/value/method) carry
 * single-letter AO form codes decoded to dollar ranges in the tool layer.
 */

/** An investment holding (Part VII). Coded income/value/method columns. */
export interface Investment {
  /** Name of the holding (e.g. "Citibank, N.A. Accounts"). */
  description: string;
  /** End-of-period gross-value code (J–P4); '' if none. */
  gross_value_code: string;
  /** Valuation-method code (Q–W); '' if none. */
  gross_value_method: string;
  id: number;
  /** Income-amount code during the reporting period (A–H2); '' if none. */
  income_during_reporting_period_code: string;
  /** Income type (e.g. "Interest", "Dividend", "Rent"); '' if none. */
  income_during_reporting_period_type: string;
  redacted: boolean;
  /** Transaction date as filed (e.g. "03/10/2022"); '' if none. */
  transaction_date_raw: string;
  /** Transaction during the period (e.g. "Buy", "Sold"); '' if none. */
  transaction_during_reporting_period: string;
  /** Transaction gain code (A–H2); '' if none. */
  transaction_gain_code: string;
  /** Identity of the transaction partner; '' if none. */
  transaction_partner: string;
  /** Transaction value code (J–P4); '' if none. */
  transaction_value_code: string;
}

/** A debt or liability (Part VII). */
export interface Debt {
  creditor_name: string;
  description: string;
  id: number;
  redacted: boolean;
  /** Gross-value code for the debt (J–P4); '' if none. */
  value_code: string;
}

/** An outside position held by the filer (Part I). */
export interface DisclosurePosition {
  id: number;
  organization_name: string;
  /** Position title (e.g. "Governing Director"). */
  position: string;
  redacted: boolean;
}

/** A travel reimbursement (Part IV). */
export interface Reimbursement {
  /** Dates as filed (e.g. "April 3-5, 2022"). */
  date_raw: string;
  id: number;
  /** Items reimbursed (e.g. "Transportation, Lodging and Meals"). */
  items_paid_or_provided: string;
  location: string;
  purpose: string;
  redacted: boolean;
  source: string;
}

/** Non-investment income of the filer (Part II). */
export interface NonInvestmentIncome {
  /** Date as filed (e.g. "3/10/2022"). */
  date_raw: string;
  id: number;
  /** Amount as filed — usually a dollar string (e.g. "$10,116.00"). */
  income_amount: string;
  redacted: boolean;
  /** Source and type of the income. */
  source_type: string;
}

/** Income of the filer's spouse (Part III). */
export interface SpouseIncome {
  date_raw: string;
  id: number;
  redacted: boolean;
  /** Source and type of the spousal income. */
  source_type: string;
}

/** A continuing agreement or arrangement (Part VIII). */
export interface Agreement {
  date_raw: string;
  id: number;
  /** Parties to and terms of the agreement. */
  parties_and_terms: string;
  redacted: boolean;
}

/**
 * Judicial financial disclosure from /financial-disclosures/{id}/ (and the list
 * endpoint). Line-item categories arrive inline as arrays — investments can run
 * to hundreds of coded entries per filing, so the search tool surfaces counts
 * while courtlistener_get_financial_disclosure returns the itemized rows.
 */
export interface FinancialDisclosure {
  agreements: Agreement[];
  debts: Debt[];
  /** URL to the source disclosure PDF on CourtListener; null if unavailable. */
  filepath: string | null;
  gifts: FinancialGift[];
  has_been_extracted: boolean;
  id: number;
  investments: Investment[];
  is_amended: boolean;
  non_investment_incomes: NonInvestmentIncome[];
  page_count: number | null;
  /** Resource URI for the filer — extract the person id and chain to get_judge. */
  person: string;
  positions: DisclosurePosition[];
  reimbursements: Reimbursement[];
  /** Report-type code (-1 unknown, 0 nomination, 1 initial, 2 annual, 3 final). */
  report_type: number;
  spouse_incomes: SpouseIncome[];
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
  /** Date the relationship ended (ISO 8601); null while the attorney is still of record. */
  date_action: string | null;
  /**
   * Docket this relationship applies to. A party record aggregates relationships across every
   * docket the party has appeared on, so this is the only way to scope attorneys to one case.
   */
  docket_id: number;
  /**
   * Numeric role code from the party–attorney relationship (e.g. 2 = "Lead attorney").
   * Nullable upstream — the field is optional on CourtListener's `Role` model, so it
   * arrives null when the PACER role text could not be mapped to a code.
   */
  role: number | null;
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
    /** Role code as sent by upstream; null when it recorded no code. */
    role_code: number | null;
    /**
     * Decoded role_code label; the stringified code when upstream sends one outside the
     * enum, "Unrecorded" when it sends none.
     */
    role: string;
    /** Date the relationship ended; null while the attorney is still of record. */
    date_action: string | null;
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
  /** Person resource URIs for the panel judges (e.g. ".../people/77/") — extract each id and chain to get_judge. */
  panel: string[];
  source: string;
  stt_status: number;
  /** Speech-to-text transcript; empty until transcription completes. */
  stt_transcript: string;
}
