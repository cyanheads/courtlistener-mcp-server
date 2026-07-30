/**
 * @fileoverview Fetch full biographical profile for a single CourtListener judge.
 * @module mcp-server/tools/definitions/get-judge.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { expandCode } from '@/services/courtlistener/codes.js';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

/**
 * The /people/{id}/ endpoint returns single-letter codes for gender, ABA rating,
 * and political affiliation, where the search endpoint returns pre-expanded labels.
 * These maps expand them so get_judge output matches search_judges. Unknown codes
 * pass through unchanged rather than being dropped or guessed.
 */
const GENDER_LABELS: Record<string, string> = { m: 'Male', f: 'Female', o: 'Other' };
const ABA_RATING_LABELS: Record<string, string> = {
  ewq: 'Exceptionally Well Qualified',
  wq: 'Well Qualified',
  q: 'Qualified',
  nq: 'Not Qualified',
  nqnot: 'Not Qualified (Not of this Time)',
};
const PARTY_LABELS: Record<string, string> = {
  d: 'Democratic',
  r: 'Republican',
  i: 'Independent',
  g: 'Green',
  l: 'Libertarian',
};
/**
 * CourtListener `Position.how_selected` selection-method codes → readable labels.
 * The complete documented enum (election, appointment, and court-restructuring
 * transfers). Unknown codes pass through unchanged via expandCode.
 */
const HOW_SELECTED_LABELS: Record<string, string> = {
  e_part: 'Partisan Election',
  e_non_part: 'Non-Partisan Election',
  a_pres: 'Appointment (President)',
  a_gov: 'Appointment (Governor)',
  a_legis: 'Appointment (Legislature)',
  a_judge: 'Appointment (Judge)',
  ct_trans: 'Transferred (Court Restructuring)',
};

/**
 * CourtListener `Position.POSITION_TYPES` (cl/people_db/models.py) → labels, complete
 * across all five groups the enum defines: judicial roles, attorney general roles,
 * appointing authorities, clerkships, and the standalone non-judicial roles. A partial
 * table would leak the raw code for whatever it omitted — the defect this decodes away.
 */
const POSITION_TYPE_LABELS: Record<string, string> = {
  // Judge
  jud: 'Judge',
  jus: 'Justice',
  'ad-law-jud': 'Administrative Law Judge',
  'act-jud': 'Acting Judge',
  'act-jus': 'Acting Justice',
  'act-pres-jud': 'Acting Presiding Judge',
  'act-c-admin-jus': 'Acting Chief Administrative Justice',
  'ass-jud': 'Associate Judge',
  'ass-jus': 'Associate Justice',
  'ass-c-jud': 'Associate Chief Judge',
  'ass-pres-jud': 'Associate Presiding Judge',
  'asst-pres-jud': 'Assistant Presiding Judge',
  'c-jud': 'Chief Judge',
  'c-jus': 'Chief Justice',
  'c-spec-m': 'Chief Special Master',
  'c-admin-jus': 'Chief Administrative Justice',
  'c-spec-tr-jud': 'Chief Special Trial Judge',
  'pres-jud': 'Presiding Judge',
  'pres-jus': 'Presiding Justice',
  'sup-jud': 'Supervising Judge',
  'ad-pres-jus': 'Administrative Presiding Justice',
  com: 'Commissioner',
  'com-dep': 'Deputy Commissioner',
  'jud-pt': 'Judge Pro Tem',
  'jus-pt': 'Justice Pro Tem',
  'ref-jud-tr': 'Judge Trial Referee',
  'ref-off': 'Official Referee',
  'ref-state-trial': 'State Trial Referee',
  'ret-act-jus': 'Active Retired Justice',
  'ret-ass-jud': 'Retired Associate Judge',
  'ret-c-jud': 'Retired Chief Judge',
  'ret-jus': 'Retired Justice',
  'ret-senior-jud': 'Senior Judge',
  mag: 'Magistrate',
  'c-mag': 'Chief Magistrate',
  'pres-mag': 'Presiding Magistrate',
  'mag-pt': 'Magistrate Pro Tem',
  'mag-rc': 'Magistrate (Recalled)',
  'mag-part-time': 'Magistrate (Part-Time)',
  'spec-chair': 'Special Chairman',
  'spec-jud': 'Special Judge',
  'spec-m': 'Special Master',
  'spec-scjcbc': 'Special Superior Court Judge for Complex Business Cases',
  'spec-tr-jud': 'Special Trial Judge',
  chair: 'Chairman',
  chan: 'Chancellor',
  'presi-jud': 'President',
  'res-jud': 'Reserve Judge',
  'trial-jud': 'Trial Judge',
  'vice-chan': 'Vice Chancellor',
  'vice-cj': 'Vice Chief Judge',
  // Attorney General
  'att-gen': 'Attorney General',
  'att-gen-ass': 'Assistant Attorney General',
  'att-gen-ass-spec': 'Special Assistant Attorney General',
  'sen-counsel': 'Senior Counsel',
  'dep-sol-gen': 'Deputy Solicitor General',
  // Appointing Authority
  pres: 'President of the United States',
  gov: 'Governor',
  mayor: 'Mayor',
  // Clerkships
  clerk: 'Clerk',
  'clerk-chief-dep': 'Chief Deputy Clerk',
  'staff-atty': 'Staff Attorney',
  // Standalone roles
  prof: 'Professor',
  'adj-prof': 'Adjunct Professor',
  prac: 'Practitioner',
  pros: 'Prosecutor',
  'pub-def': 'Public Defender',
  da: 'District Attorney',
  ada: 'Assistant District Attorney',
  legis: 'Legislator',
  sen: 'Senator',
  'state-sen': 'State Senator',
};

/** CourtListener `Position.TERMINATION_REASONS` → labels. The complete enum. */
const TERMINATION_REASON_LABELS: Record<string, string> = {
  ded: 'Death',
  retire_vol: 'Voluntary Retirement',
  retire_mand: 'Mandatory Retirement',
  resign: 'Resigned',
  other_pos: 'Appointed to Other Judgeship',
  lost: 'Lost Election',
  abolished: 'Court Abolished',
  bad_judge: 'Impeached and Convicted',
  recess_not_confirmed: 'Recess Appointment Not Confirmed',
  termed_out: 'Term Limit Reached',
};

/** CourtListener `Education.DEGREE_LEVELS` → labels. The complete enum. */
const DEGREE_LEVEL_LABELS: Record<string, string> = {
  ba: "Bachelor's (e.g. B.A.)",
  ma: "Master's (e.g. M.A.)",
  jd: 'Juris Doctor (J.D.)',
  llm: 'Master of Laws (LL.M)',
  llb: 'Bachelor of Laws (e.g. LL.B)',
  jsd: 'Doctor of Law (J.S.D)',
  phd: 'Doctor of Philosophy (PhD)',
  aa: 'Associate (e.g. A.A.)',
  md: 'Medical Degree (M.D.)',
  mba: 'Master of Business Administration (M.B.A.)',
  cfa: 'Accounting Certification (C.P.A., C.M.A., C.F.A.)',
  cert: 'Certificate',
};

/**
 * CourtListener `DATE_GRANULARITIES` → the precision each strftime pattern describes.
 * Keys are lowercased to match expandCode's case-insensitive lookup; upstream sends
 * "%Y", "%Y-%m", and "%Y-%m-%d", and `''` when the precision was never recorded.
 */
const DATE_GRANULARITY_LABELS: Record<string, string> = {
  '%y': 'year',
  '%y-%m': 'month',
  '%y-%m-%d': 'day',
};

/**
 * Decode one granularity column. Blank — upstream's "never recorded" — becomes null
 * rather than the empty string expandCode returns for an absent code, so the four
 * granularity fields report the same thing when the precision is unknown.
 */
const decodeGranularity = (granularity: string | null): string | null =>
  expandCode(DATE_GRANULARITY_LABELS, granularity) || null;

/**
 * Render a date to the precision CourtListener recorded for it. A year-only record
 * is stored as `YYYY-01-01` and a month-only one as `YYYY-MM-01`, so printing the
 * stored value asserts a day the source never claimed. A granularity outside the
 * documented three is surfaced verbatim rather than assumed to mean day precision.
 */
const renderDate = (date: string, granularity: string | null): string => {
  if (granularity === 'year') return date.slice(0, 4);
  if (granularity === 'month') return date.slice(0, 7);
  if (granularity && granularity !== 'day') return `${date} (granularity: ${granularity})`;
  return date;
};

/**
 * The bracketed raw code shown beside an expanded label — CourtListener's filter
 * parameters take the code, not the label. Empty when the code is absent or when
 * it is the label (an unmapped code passes through, so repeating it says nothing).
 */
const codeSuffix = (label: string, code: string | null): string =>
  code && code !== label ? ` [${code}]` : '';

export const getJudgeTool = tool('courtlistener_get_judge', {
  title: 'Get Judge Profile',
  description:
    'Fetch full biographical profile for a single judge: positions on record — judicial appointments across all courts plus non-judicial roles — education, political affiliations, and ABA ratings. The position list is paginated upstream and walked under a page bound; the response reports whether it was truncated. Obtain person IDs from courtlistener_search_judges results.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    person_id: z
      .number()
      .int()
      .describe(
        "Judge person ID from a search result's person_id field. Identifies a specific judge across all courts they have served on.",
      ),
  }),

  output: z.object({
    person_id: z.number().describe('Person ID.'),
    name: z.string().describe('Full name.'),
    gender: z.string().describe('Gender.'),
    dob: z
      .string()
      .nullable()
      .describe(
        'Date of birth as CourtListener stores it, always full ISO 8601 — but the month and day are placeholders unless dob_granularity is "day". Read dob_granularity before presenting this as an exact date. Null if not recorded.',
      ),
    dob_granularity: z
      .string()
      .nullable()
      .describe(
        'Precision actually recorded for dob: "year", "month", or "day". Null when CourtListener recorded no precision. An unrecognized upstream value passes through unchanged.',
      ),
    dob_city: z.string().nullable().describe('City of birth; null if not recorded.'),
    dob_state: z.string().nullable().describe('State of birth; null if not recorded.'),
    dod: z
      .string()
      .nullable()
      .describe(
        'Date of death as CourtListener stores it, always full ISO 8601 — precision qualified by dod_granularity, as with dob. Null if living or not recorded.',
      ),
    dod_granularity: z
      .string()
      .nullable()
      .describe(
        'Precision actually recorded for dod: "year", "month", or "day". Null when CourtListener recorded no precision.',
      ),
    fjc_id: z
      .number()
      .nullable()
      .describe(
        'Federal Judicial Center ID for cross-referencing with FJC data; null if not available.',
      ),
    aba_ratings: z
      .array(z.string())
      .describe('ABA qualification ratings, expanded to readable labels (e.g., "Well Qualified").'),
    political_affiliations: z
      .array(
        z
          .object({
            affiliation: z
              .string()
              .describe('Political party, expanded to a readable label (e.g., "Democratic").'),
            date_start: z.string().nullable().describe('Start date of this affiliation.'),
            date_end: z
              .string()
              .nullable()
              .describe('End date of this affiliation; null if current.'),
          })
          .describe('Political affiliation entry.'),
      )
      .describe('Political affiliation history.'),
    education: z
      .array(
        z
          .object({
            school: z.string().describe('Educational institution name.'),
            degree: z
              .string()
              .nullable()
              .describe('Raw CourtListener degree-level code (e.g. "ba"); null if not recorded.'),
            degree_label: z
              .string()
              .nullable()
              .describe(
                'Degree level expanded to a readable label (e.g. "Juris Doctor (J.D.)"). An unmapped code passes through as the code itself; null if not recorded.',
              ),
            year: z.number().nullable().describe('Graduation year; null if not recorded.'),
          })
          .describe('Education record.'),
      )
      .describe('Educational history.'),
    positions: z
      .array(
        z
          .object({
            court: z.string().describe('Court name.'),
            court_id: z
              .string()
              .describe('Court identifier — use to filter opinions by this judge.'),
            position_type: z
              .string()
              .describe(
                'Raw CourtListener position-type code (e.g. "jud", "c-jud") — the value the /positions/ position_type filter takes. Empty for non-judicial roles, which describe themselves in job_title.',
              ),
            position_type_label: z
              .string()
              .describe(
                'Position type expanded to a readable label (e.g. "Judge", "Chief Judge"). An unmapped code passes through as the code itself; empty for non-judicial roles.',
              ),
            job_title: z
              .string()
              .describe(
                'Free-text title for a role with no position_type code (e.g. "Assistant district attorney"); empty on judicial rows.',
              ),
            organization_name: z
              .string()
              .describe(
                'Employer for a non-judicial role; empty on judicial rows, which use court.',
              ),
            appointer: z
              .string()
              .nullable()
              .describe(
                'Position URI of the appointing authority (e.g., ".../positions/123/"), not resolved to a name; null if elected or not recorded.',
              ),
            nomination_process: z
              .string()
              .nullable()
              .describe(
                'Selection method, expanded to a readable label (e.g., "Appointment (President)"); null if not recorded.',
              ),
            date_nominated: z.string().nullable().describe('Date nominated; null if not recorded.'),
            date_confirmation: z
              .string()
              .nullable()
              .describe('Date confirmed; null if not recorded.'),
            date_start: z
              .string()
              .nullable()
              .describe(
                'Date the position started as CourtListener stores it, always full ISO 8601 — the month and day are placeholders unless date_start_granularity is "day". Null if not recorded.',
              ),
            date_start_granularity: z
              .string()
              .nullable()
              .describe(
                'Precision actually recorded for date_start: "year", "month", or "day". Null when CourtListener recorded no precision.',
              ),
            date_termination: z
              .string()
              .nullable()
              .describe(
                'Date the position ended as CourtListener stores it, always full ISO 8601 — precision qualified by date_termination_granularity. Null if current.',
              ),
            date_termination_granularity: z
              .string()
              .nullable()
              .describe(
                'Precision actually recorded for date_termination: "year", "month", or "day". Null when CourtListener recorded no precision.',
              ),
            termination_reason: z
              .string()
              .nullable()
              .describe(
                'Raw CourtListener termination-reason code (e.g. "other_pos"); null if still serving.',
              ),
            termination_reason_label: z
              .string()
              .nullable()
              .describe(
                'Termination reason expanded to a readable label (e.g. "Appointed to Other Judgeship"). An unmapped code passes through as the code itself; null if still serving.',
              ),
          })
          .describe('Position record — judicial or otherwise.'),
      )
      .describe(
        'Positions on record, across all courts — judicial appointments plus non-judicial roles (private practice, prosecutor, professor), which carry no court and describe themselves in job_title. CourtListener paginates this list and the walk is bounded, so read the truncated flag before treating it as a complete career.',
      ),
  }),

  // Agent-facing context the positions array cannot carry on its own: CourtListener
  // paginates /positions/ and the walk is bounded, so a short list has two possible
  // meanings — a short career, or a bound that stopped short of the whole history.
  enrichment: {
    positionsShown: z.number().describe('Number of position records returned.'),
    truncated: z
      .boolean()
      .describe(
        "True when the bounded /positions/ page walk stopped with pages outstanding — positions[] is then a prefix of the person's record, not the whole of it. False when the walk reached the end.",
      ),
    notice: z
      .string()
      .optional()
      .describe('Present only when positions[] was truncated: what was withheld.'),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Person ID does not exist in CourtListener.',
      recovery:
        'Verify the person ID from courtlistener_search_judges. The person may not be in the CourtListener database.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: '429 response from CourtListener.',
      retryable: false,
      recovery:
        'Wait out the Retry-After interval reported on the error before calling again. CourtListener throttles per minute, hour, and day, so an immediate retry fails.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_get_judge', { person_id: input.person_id });
    const svc = getCourtListenerService();
    const person = await svc.getPerson(input.person_id, ctx);

    // aba_ratings/political_affiliations arrive as single-letter codes — expand to
    // readable labels so output matches courtlistener_search_judges.
    const aba_ratings = (person.aba_ratings ?? [])
      .map((r) => expandCode(ABA_RATING_LABELS, r.rating))
      .filter(Boolean);

    const political_affiliations = (person.political_affiliations ?? []).map((pa) => ({
      affiliation: expandCode(PARTY_LABELS, pa.political_party),
      date_start: pa.date_start ?? null,
      date_end: pa.date_end ?? null,
    }));

    const education = (person.educations ?? []).map((e) => ({
      school: e.school?.name ?? '',
      // Upstream's degree_level/termination_reason are blank-able CharFields, never
      // null — normalize the blank to null so the raw field and its _label twin agree
      // on how "not recorded" reads, and so the schema's `null` actually appears.
      degree: e.degree_level || null,
      degree_label: e.degree_level ? expandCode(DEGREE_LEVEL_LABELS, e.degree_level) : null,
      year: e.degree_year ?? null,
    }));

    // positions were fetched separately and court is a nested object
    const positions = (person.positions ?? []).map((p) => ({
      court: p.court?.full_name ?? '',
      court_id: p.court?.id ?? '',
      position_type: p.position_type ?? '',
      position_type_label: expandCode(POSITION_TYPE_LABELS, p.position_type),
      // A row with no position_type is a non-judicial role: upstream leaves the
      // coded columns blank and puts the whole description in these two fields.
      job_title: p.job_title ?? '',
      organization_name: p.organization_name ?? '',
      // appointer is a position URI; resolving it to the appointing person's name
      // needs extra /positions/ → /people/ hops (deferred — rate-limit-sensitive).
      appointer: p.appointer ?? null,
      // how_selected is a coded selection method (e.g. "a_pres") — expand to a
      // readable label; fall back to nomination_process when how_selected is absent.
      nomination_process: p.how_selected
        ? expandCode(HOW_SELECTED_LABELS, p.how_selected)
        : (p.nomination_process ?? null),
      date_nominated: p.date_nominated ?? null,
      date_confirmation: p.date_confirmation ?? null,
      date_start: p.date_start ?? null,
      date_start_granularity: decodeGranularity(p.date_granularity_start),
      date_termination: p.date_termination ?? null,
      date_termination_granularity: decodeGranularity(p.date_granularity_termination),
      termination_reason: p.termination_reason || null,
      termination_reason_label: p.termination_reason
        ? expandCode(TERMINATION_REASON_LABELS, p.termination_reason)
        : null,
    }));

    // name_full is null on /people/ — fall back to first + last
    const name =
      person.name_full ?? [person.name_first, person.name_last].filter(Boolean).join(' ') ?? '';

    ctx.log.info('courtlistener_get_judge complete', {
      person_id: input.person_id,
      positions_count: positions.length,
    });

    const truncated = person.positions_truncated === true;
    ctx.enrich({ positionsShown: positions.length, truncated });
    if (truncated) {
      ctx.enrich.notice(
        `Position history is partial: ${positions.length} records returned and more remain. CourtListener paginates /positions/ and this walk is bounded, so roles past the bound are absent — treat this as a prefix of the record, not the full career.`,
      );
    }

    return {
      person_id: person.id,
      name,
      gender: expandCode(GENDER_LABELS, person.gender),
      dob: person.date_dob ?? null,
      // The stored date is always full ISO 8601; the granularity is the only thing
      // that says how much of it CourtListener actually knows.
      dob_granularity: decodeGranularity(person.date_granularity_dob),
      // Blank-able CharFields upstream, like degree_level and termination_reason —
      // normalize "" to the null these fields already advertise.
      dob_city: person.dob_city || null,
      dob_state: person.dob_state || null,
      dod: person.date_dod ?? null,
      dod_granularity: decodeGranularity(person.date_granularity_dod),
      fjc_id: person.fjc_id ?? null,
      aba_ratings,
      political_affiliations,
      education,
      positions,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## ${result.name}`,
      `**Person ID:** ${result.person_id} | **Gender:** ${result.gender}`,
    ];

    if (result.dob) {
      lines.push(
        `**Born:** ${renderDate(result.dob, result.dob_granularity)}${result.dob_city ? `, ${result.dob_city}` : ''}${result.dob_state ? `, ${result.dob_state}` : ''}`,
      );
    }
    if (result.dod) lines.push(`**Died:** ${renderDate(result.dod, result.dod_granularity)}`);
    if (result.fjc_id) lines.push(`**FJC ID:** ${result.fjc_id}`);
    if (result.aba_ratings.length > 0)
      lines.push(`**ABA ratings:** ${result.aba_ratings.join(', ')}`);

    if (result.political_affiliations.length > 0) {
      lines.push('\n**Political affiliations:**');
      for (const pa of result.political_affiliations) {
        const range = [pa.date_start, pa.date_end].filter(Boolean).join(' – ');
        lines.push(`  - ${pa.affiliation}${range ? ` (${range})` : ''}`);
      }
    }

    if (result.education.length > 0) {
      lines.push('\n**Education:**');
      for (const e of result.education) {
        const degree = e.degree_label
          ? `, ${e.degree_label}${codeSuffix(e.degree_label, e.degree)}`
          : '';
        lines.push(`  - ${e.school}${degree}${e.year ? ` (${e.year})` : ''}`);
      }
    }

    if (result.positions.length > 0) {
      lines.push('\n**Positions:**');
      for (const p of result.positions) {
        // The term reads to the precision each end was recorded at, for the same reason
        // **Born:** does — a year-only appointment is stored as YYYY-01-01.
        const term = [
          p.date_start && renderDate(p.date_start, p.date_start_granularity),
          p.date_termination
            ? renderDate(p.date_termination, p.date_termination_granularity)
            : 'present',
        ]
          .filter(Boolean)
          .join(' – ');
        // A judicial row describes itself with position_type + court; every other role
        // with job_title + organization_name, the coded columns left blank upstream.
        const title = p.position_type_label || p.job_title;
        const where = p.court || p.organization_name;
        lines.push(
          `\n  **${title}**${codeSuffix(p.position_type_label, p.position_type)}${where ? ` at ${where}` : ''}${p.court_id ? ` (${p.court_id})` : ''}`,
        );
        // Render both title/place variants so neither surface loses a field the other carries.
        if (p.job_title && p.position_type_label) lines.push(`  Job title: ${p.job_title}`);
        if (p.organization_name && p.court) lines.push(`  Organization: ${p.organization_name}`);
        if (term) lines.push(`  Term: ${term}`);
        if (p.appointer) lines.push(`  Appointed by: ${p.appointer}`);
        if (p.nomination_process) lines.push(`  Nomination process: ${p.nomination_process}`);
        if (p.date_nominated) lines.push(`  Nominated: ${p.date_nominated}`);
        if (p.date_confirmation) lines.push(`  Confirmed: ${p.date_confirmation}`);
        if (p.termination_reason_label) {
          lines.push(
            `  Ended: ${p.termination_reason_label}${codeSuffix(p.termination_reason_label, p.termination_reason)}`,
          );
        }
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
