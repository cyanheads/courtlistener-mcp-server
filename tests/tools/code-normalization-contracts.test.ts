/**
 * @fileoverview Coded labels through real detail fetching, normalization and both MCP surfaces.
 * @module tests/tools/code-normalization-contracts.test
 */

import { createInMemoryStorage, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getJudgeTool } from '@/mcp-server/tools/definitions/get-judge.tool.js';
import { getOpinionTool } from '@/mcp-server/tools/definitions/get-opinion.tool.js';
import {
  disposeCourtListenerService,
  initCourtListenerService,
} from '@/services/courtlistener/courtlistener-service.js';

let code: string;
const fetchStub = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchStub.mockReset().mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/people/1/'))
      return Response.json({ id: 1, name_full: 'Fixture Judge', gender: code });
    if (path.endsWith('/positions/')) return Response.json({ count: 0, next: null, results: [] });
    if (path.endsWith('/clusters/1/'))
      return Response.json({ id: 1, case_name: 'Fixture Opinion', sub_opinions: [] });
    if (path.endsWith('/opinions/'))
      return Response.json({
        count: 2,
        next: null,
        results: [
          { id: 2, type: '010combined' },
          { id: 3, type: code },
        ],
      });
    throw new Error(`Unexpected fixture path ${path}`);
  });
  vi.stubGlobal('fetch', fetchStub);
  initCourtListenerService(
    {
      apiToken: 'fixture',
      mcpServerVersion: '0.0.0-test',
      rateLimitPerMinute: 10_000,
      rateLimitPerHour: 100_000,
    },
    createInMemoryStorage(),
  );
});

afterEach(() => {
  disposeCourtListenerService();
  vi.unstubAllGlobals();
});

describe('code normalization characterization', () => {
  it.each([
    ['M', 'Male'],
    ['UnmappedCode', 'UnmappedCode'],
    ['', ''],
  ])('judge gender %s stays %s on both surfaces', async (raw, label) => {
    code = raw;
    const result = await runToolContract(getJudgeTool, { person_id: 1 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ gender: label });
    expect(JSON.stringify(result.content)).toContain(`**Gender:** ${label}`);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['030CONCURRENCE', 'concurrence-opinion'],
    ['UnmappedCode', 'UnmappedCode'],
    ['', ''],
  ])('opinion type %s stays %s in a second variant', async (raw, label) => {
    code = raw;
    const result = await runToolContract(getOpinionTool, { cluster_id: 1 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      opinions: [{ type_label: 'combined-opinion' }, { type: raw, type_label: label }],
    });
    expect(JSON.stringify(result.content)).toContain(`Opinion (${label})`);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});

describe('unknown prototype-name code regressions (#72)', () => {
  it.each(['constructor', 'CONSTRUCTOR', '__proto__', '__PROTO__'])(
    'preserves %s through judge output contracts',
    async (raw) => {
      code = raw;
      const judge = await runToolContract(getJudgeTool, { person_id: 1 });
      expect(judge.isError).not.toBe(true);
      expect(judge.structuredContent).toMatchObject({ gender: raw });
      expect(JSON.stringify(judge.content)).toContain(`**Gender:** ${raw}`);
      expect(fetchStub).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['constructor', 'CONSTRUCTOR', '__proto__', '__PROTO__'])(
    'preserves %s through a second opinion variant',
    async (raw) => {
      code = raw;
      const opinion = await runToolContract(getOpinionTool, { cluster_id: 1 });
      expect(opinion.isError).not.toBe(true);
      expect(opinion.structuredContent).toMatchObject({
        opinions: [{ type_label: 'combined-opinion' }, { type: raw, type_label: raw }],
      });
      expect(JSON.stringify(opinion.content)).toContain(`Opinion (${raw})`);
      expect(fetchStub).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['constructor', '__proto__'])('preserves %s in nested judge records', async (raw) => {
    fetchStub.mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/people/1/'))
        return Response.json({
          id: 1,
          name_full: 'Fixture Judge',
          gender: 'f',
          aba_ratings: [{ rating: 'q' }, { rating: raw }],
          political_affiliations: [{ political_party: 'd' }, { political_party: raw }],
          educations: [
            { school: { name: 'College' }, degree_level: 'ba' },
            { school: { name: 'Law school' }, degree_level: raw },
          ],
        });
      if (path.endsWith('/positions/'))
        return Response.json({
          count: 2,
          next: null,
          results: [
            { id: 1, position_type: 'jud' },
            {
              id: 2,
              position_type: raw,
              how_selected: raw,
              termination_reason: raw,
              date_start: '2000-01-01',
              date_granularity_start: raw,
            },
          ],
        });
      throw new Error(`Unexpected fixture path ${path}`);
    });
    const result = await runToolContract(getJudgeTool, { person_id: 1 });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      gender: 'Female',
      aba_ratings: ['Qualified', raw],
      political_affiliations: [{ affiliation: 'Democratic' }, { affiliation: raw }],
      education: [{ degree: 'ba' }, { degree: raw, degree_label: raw }],
      positions: [
        { position_type_label: 'Judge' },
        {
          position_type: raw,
          position_type_label: raw,
          nomination_process: raw,
          termination_reason: raw,
          termination_reason_label: raw,
          date_start_granularity: raw,
        },
      ],
    });
    const text = JSON.stringify(result.content);
    expect(text).toContain(`**ABA ratings:** Qualified, ${raw}`);
    expect(text).toContain(`- ${raw}`);
    expect(text).toContain(`Law school, ${raw}`);
    expect(text).toContain(`**${raw}**`);
    expect(text).toContain(`Nomination process: ${raw}`);
    expect(text).toContain(`Ended: ${raw}`);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
