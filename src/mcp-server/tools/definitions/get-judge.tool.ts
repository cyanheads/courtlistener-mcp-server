/**
 * @fileoverview Fetch full biographical profile for a single CourtListener judge.
 * @module mcp-server/tools/definitions/get-judge.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';

export const getJudgeTool = tool('courtlistener_get_judge', {
  title: 'Get Judge Profile',
  description:
    'Fetch full biographical profile for a single judge: appointment history across all courts, education, political affiliations, and ABA ratings. Obtain person IDs from courtlistener_search_judges results.',
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
    dob: z.string().nullable().describe('Date of birth; null if not recorded.'),
    dob_city: z.string().nullable().describe('City of birth; null if not recorded.'),
    dob_state: z.string().nullable().describe('State of birth; null if not recorded.'),
    dod: z.string().nullable().describe('Date of death; null if living or not recorded.'),
    fjc_id: z
      .string()
      .nullable()
      .describe(
        'Federal Judicial Center ID for cross-referencing with FJC data; null if not available.',
      ),
    aba_ratings: z.array(z.string()).describe('ABA qualification ratings.'),
    political_affiliations: z
      .array(
        z
          .object({
            affiliation: z.string().describe('Political party or affiliation code.'),
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
            degree: z.string().nullable().describe('Degree level; null if not recorded.'),
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
              .describe('Position title (e.g., "District Judge", "Circuit Judge", "Justice").'),
            appointer: z
              .string()
              .nullable()
              .describe('Appointing president name; null if elected or not recorded.'),
            nomination_process: z
              .string()
              .nullable()
              .describe('Nomination process; null if not recorded.'),
            date_nominated: z.string().nullable().describe('Date nominated; null if not recorded.'),
            date_confirmation: z
              .string()
              .nullable()
              .describe('Date confirmed; null if not recorded.'),
            date_start: z
              .string()
              .nullable()
              .describe('Date position started; null if not recorded.'),
            date_termination: z
              .string()
              .nullable()
              .describe('Date position ended; null if current.'),
            termination_reason: z
              .string()
              .nullable()
              .describe('Reason for termination; null if still serving.'),
          })
          .describe('Judicial position record.'),
      )
      .describe('All judicial positions held, across all courts.'),
  }),

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
      retryable: true,
      recovery: 'Wait for the Retry-After period. Free tier: 5 req/min, 50/hr, 125/day.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('courtlistener_get_judge', { person_id: input.person_id });
    const svc = getCourtListenerService();
    const person = await svc.getPerson(input.person_id, ctx);

    const aba_ratings = (person.aba_ratings ?? []).map((r) => r.rating ?? '').filter(Boolean);

    const political_affiliations = (person.political_affiliations ?? []).map((pa) => ({
      affiliation: pa.political_party ?? '',
      date_start: pa.date_start ?? null,
      date_end: pa.date_end ?? null,
    }));

    const education = (person.educations ?? []).map((e) => ({
      school: e.school?.name ?? '',
      degree: e.degree_level ?? null,
      year: e.graduation_year ?? null,
    }));

    const positions = (person.positions ?? []).map((p) => ({
      court: p.court ?? '',
      court_id: p.court_id ?? '',
      position_type: p.position_type ?? '',
      appointer: p.appointer ?? null,
      nomination_process: p.how_selected ?? null,
      date_nominated: p.date_nominated ?? null,
      date_confirmation: p.date_confirmation ?? null,
      date_start: p.date_start ?? null,
      date_termination: p.date_termination ?? null,
      termination_reason: p.termination_reason ?? null,
    }));

    ctx.log.info('courtlistener_get_judge complete', {
      person_id: input.person_id,
      positions_count: positions.length,
    });

    return {
      person_id: person.id,
      name: person.name_full ?? '',
      gender: person.gender ?? '',
      dob: person.date_dob ?? null,
      dob_city: person.dob_city ?? null,
      dob_state: person.dob_state ?? null,
      dod: person.date_dod ?? null,
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
        `**Born:** ${result.dob}${result.dob_city ? `, ${result.dob_city}` : ''}${result.dob_state ? `, ${result.dob_state}` : ''}`,
      );
    }
    if (result.dod) lines.push(`**Died:** ${result.dod}`);
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
        lines.push(
          `  - ${e.school}${e.degree ? `, ${e.degree}` : ''}${e.year ? ` (${e.year})` : ''}`,
        );
      }
    }

    if (result.positions.length > 0) {
      lines.push('\n**Judicial positions:**');
      for (const p of result.positions) {
        const term = [p.date_start, p.date_termination ?? 'present'].filter(Boolean).join(' – ');
        lines.push(`\n  **${p.position_type}** at ${p.court} (${p.court_id})`);
        if (term) lines.push(`  Term: ${term}`);
        if (p.appointer) lines.push(`  Appointed by: ${p.appointer}`);
        if (p.nomination_process) lines.push(`  Nomination process: ${p.nomination_process}`);
        if (p.date_nominated) lines.push(`  Nominated: ${p.date_nominated}`);
        if (p.date_confirmation) lines.push(`  Confirmed: ${p.date_confirmation}`);
        if (p.termination_reason) lines.push(`  Ended: ${p.termination_reason}`);
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
