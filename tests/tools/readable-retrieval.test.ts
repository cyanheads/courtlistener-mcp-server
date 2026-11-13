/**
 * @fileoverview Retrieval wire bounds and readable legal text regressions.
 * @module tests/tools/readable-retrieval.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { getCitationsTool } from '@/mcp-server/tools/definitions/get-citations.tool.js';
import { getFinancialDisclosureTool } from '@/mcp-server/tools/definitions/get-financial-disclosure.tool.js';
import { getOpinionTool } from '@/mcp-server/tools/definitions/get-opinion.tool.js';
import { getOralArgumentTool } from '@/mcp-server/tools/definitions/get-oral-argument.tool.js';
import { searchOpinionsTool } from '@/mcp-server/tools/definitions/search-opinions.tool.js';
import * as service from '@/services/courtlistener/courtlistener-service.js';
import { fenceSource, readableText } from '@/services/courtlistener/readable-text.js';
import { formatRetrievalPage, retrieve } from '@/services/courtlistener/retrieval.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it('labels opinion outlines and binds a plain-only continuation to its text mode', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const plain = 'Body 😀. '.repeat(5000);
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getOpinionCluster: async () => ({
      id: 1,
      sub_opinions: [
        { id: 2, type: '020lead', author_id: 7, plain_text: plain, html: '<p>markup</p>' },
      ],
    }),
  } as unknown as service.CourtListenerService);
  const input = { cluster_id: 1, text: 'plain' } as const;
  const first = await runToolContract(getOpinionTool, input);
  const outline = getOpinionTool.output.parse(first.structuredContent);
  expect(outline.sections?.[0]).toMatchObject({
    name: 'opinion_2',
    type_label: 'lead-opinion',
    author_id: 7,
    per_curiam: false,
  });
  expect(first.content[0]).toMatchObject({ text: expect.stringContaining('lead\\-opinion') });
  const crossMode = await runToolContract(getOpinionTool, {
    cluster_id: 1,
    cursor: outline.retrieval?.next_cursor ?? undefined,
  });
  expect(crossMode.structuredContent).toMatchObject({
    error: { data: { reason: 'invalid_cursor' } },
  });
  const result = await walk((cursor) => runToolContract(getOpinionTool, { ...input, cursor }));
  expect(result.chunks.get('/opinions/0/plain_text')).toBe(plain);
  expect(result.pages.some((page) => JSON.stringify(page).includes('html_text'))).toBe(false);

  const html = await runToolContract(getOpinionTool, { cluster_id: 1, text: 'html' });
  const htmlPage = getOpinionTool.output.parse(html.structuredContent);
  expect(htmlPage.opinions?.[0]?.html_text).toBe('<p>markup</p>');
  expect(htmlPage.opinions?.[0]?.plain_text).toBeUndefined();
  expect(html.content[0]).toMatchObject({ text: expect.stringContaining('<p>markup</p>') });

  const both = await runToolContract(getOpinionTool, { cluster_id: 1 });
  expect(await runToolContract(getOpinionTool, { cluster_id: 1, text: 'both' })).toEqual(both);
  const bothCursor =
    getOpinionTool.output.parse(both.structuredContent).retrieval?.next_cursor ?? undefined;
  expect(bothCursor).toBeTypeOf('string');
  const defaultPage = await runToolContract(getOpinionTool, { cluster_id: 1, cursor: bothCursor });
  expect(
    await runToolContract(getOpinionTool, {
      cluster_id: 1,
      text: 'both',
      cursor: bothCursor,
    }),
  ).toEqual(defaultPage);
});

it('adds the CourtListener MP3 to audio detail and preserves the court URL', async () => {
  const download_url = 'https://court.example/oral-argument.mp3';
  const local_path = 'https://storage.courtlistener.com/mp3/recording.mp3';
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getOralArgument: async () => ({ id: 8, download_url, local_path_mp3: 'mp3/recording.mp3' }),
  } as unknown as service.CourtListenerService);
  const wire = await runToolContract(getOralArgumentTool, { id: 8 });
  expect(wire.structuredContent).toMatchObject({ download_url, local_path });
  expect(wire.content[0]).toMatchObject({ text: expect.stringContaining(`(<${local_path}>)`) });
});

it('continues old audio cursors with their original projection', async () => {
  const transcript = 'One original line 😀. '.repeat(8000);
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getOralArgument: async () => ({
      id: 8,
      stt_transcript: transcript,
      local_path_mp3: 'mp3/new.mp3',
    }),
  } as unknown as service.CourtListenerService);
  const old = retrieve({
    tool: 'audio',
    id: 8,
    view: {
      oral_argument_id: 8,
      case_name: '',
      case_name_full: '',
      docket_id: 0,
      duration_seconds: 0,
      download_url: null,
      judges: '',
      panel_ids: [],
      has_transcript: true,
      transcript,
    },
    groups: [{ name: 'transcript', value: transcript }],
    required: ['oral_argument_id', 'docket_id', 'duration_seconds', 'has_transcript'],
    finalize: (value) => ({
      structuredContent: getOralArgumentTool.output.parse(value),
      content: formatRetrievalPage(getOralArgumentTool.output.parse(value), false),
    }),
  });
  let cursor = old.retrieval?.next_cursor;
  const slices: string[] = [];
  while (cursor) {
    const wire = await runToolContract(getOralArgumentTool, { id: 8, cursor });
    const page = getOralArgumentTool.output.parse(wire.structuredContent);
    expect(page.local_path).toBeUndefined();
    slices.push(...(page.retrieval?.text_chunks.map((chunk) => chunk.text) ?? []));
    expect(page.retrieval?.next_cursor).not.toBe(cursor);
    cursor = page.retrieval?.next_cursor;
  }
  expect(slices.join('')).toBe(transcript);
});

it('recovers an oversized unmapped opinion label from ordinary variant data', async () => {
  const type = 'custom 😀 '.repeat(5000);
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getOpinionCluster: async () => ({
      id: 1,
      sub_opinions: [{ id: 2, type, author_id: null, per_curiam: true }],
    }),
  } as unknown as service.CourtListenerService);
  const result = await walk((cursor) => runToolContract(getOpinionTool, { cluster_id: 1, cursor }));
  expect(result.pages[0]?.sections).toMatchObject([
    { name: 'opinion_2', author_id: null, per_curiam: true },
  ]);
  expect(result.chunks.get('/opinions/0/type_label')).toBe(type);
});

it('keeps the measured parse-plus-production-format success invariant explicit', () => {
  for (const definition of [getOpinionTool, getOralArgumentTool, getFinancialDisclosureTool]) {
    expect(definition.format).toBeTypeOf('function');
    expect(definition.enrichment).toBeUndefined();
  }
});

it('pages an oversized source-completion cursor without substituting null or losing completion', async () => {
  const upstreamCursor = 'source-next-'.repeat(4000);
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getOpinionCluster: async () => ({
      id: 1,
      sub_opinions: [],
      variants_completion: { complete: false, next_cursor: upstreamCursor },
    }),
  } as unknown as service.CourtListenerService);
  const result = await walk((cursor) => runToolContract(getOpinionTool, { cluster_id: 1, cursor }));
  expect(result.chunks.get('/variants_completion/next_cursor')).toBe(upstreamCursor);
  for (const page of result.pages) expect(page.variants_completion).toEqual({ complete: false });
});

async function walk(call: (cursor?: string) => ReturnType<typeof runToolContract>) {
  const pages: Record<string, unknown>[] = [];
  const chunks = new Map<string, string>();
  let token: string | undefined;
  let maxContent = 0;
  do {
    const wire = await call(token);
    expect(wire.isError, JSON.stringify(wire)).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(wire.structuredContent))).toBeLessThanOrEqual(24_000);
    const contentBytes = Buffer.byteLength(JSON.stringify(wire.content));
    expect(contentBytes).toBeLessThanOrEqual(24_000);
    maxContent = Math.max(maxContent, contentBytes);
    const page = wire.structuredContent as Record<string, unknown>;
    const retrieval = page.retrieval as
      | {
          next_cursor: string | null;
          ranges: { path: string; start: number; end: number; total: number; unit: string }[];
          text_chunks: { path: string; text: string }[];
        }
      | undefined;
    for (const chunk of retrieval?.text_chunks ?? []) {
      const range = retrieval?.ranges.find(
        (range) => range.path === chunk.path && range.unit === 'code_points',
      );
      expect(range?.start).toBe(Array.from(chunks.get(chunk.path) ?? '').length);
      chunks.set(chunk.path, (chunks.get(chunk.path) ?? '') + chunk.text);
      expect(Array.from(chunks.get(chunk.path) ?? '').length).toBe(range?.end);
      expect(range?.end).toBeLessThanOrEqual(range?.total ?? 0);
    }
    if (token) expect(await call(token)).toEqual(wire);
    pages.push(page);
    expect(pages.length).toBeLessThan(200);
    expect(retrieval?.next_cursor).not.toBe(token);
    token = retrieval?.next_cursor ?? undefined;
  } while (token);
  return { pages, chunks, maxContent };
}

it('characterizes supplied plain opinion text without changing whitespace', async () => {
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getOpinionCluster: async () => ({
      id: 1,
      sub_opinions: [{ id: 2, plain_text: ' A\n\n B & C ' }],
    }),
  } as unknown as service.CourtListenerService);
  const wire = await runToolContract(getOpinionTool, { cluster_id: 1 });
  expect(wire.structuredContent).toMatchObject({ opinions: [{ plain_text: ' A\n\n B & C ' }] });
});

it('reconstructs primary opinion text while docket backfill crosses inline thresholds and fails', async () => {
  const texts = ['first 😀'.repeat(7000), 'second 界'.repeat(4000)];
  let turn = 0;
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getOpinionCluster: async () => ({
      id: 1,
      docket_id: 10,
      court: 'Original court',
      variants_completion: { complete: false, next_cursor: 'remaining-variants' },
      sub_opinions: texts.map((plain_text, index) => ({ id: index + 2, plain_text })),
    }),
    getDocketSummary: async () => {
      const state = turn++ % 4;
      if (state === 1) throw new Error('private upstream failure');
      return {
        court_id: state === 2 ? 'court<&'.repeat(2000) : 'scotus',
        docket_number: state === 3 ? '' : 'number'.repeat(state === 2 ? 2000 : 1),
      };
    },
  } as unknown as service.CourtListenerService);
  const rebuilt = new Map<string, string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const wire = await runToolContract(getOpinionTool, { cluster_id: 1, cursor });
    expect(wire.isError, JSON.stringify(wire)).not.toBe(true);
    const page = getOpinionTool.output.parse(wire.structuredContent);
    expect(Buffer.byteLength(JSON.stringify(wire.structuredContent))).toBeLessThanOrEqual(24_000);
    expect(Buffer.byteLength(JSON.stringify(wire.content))).toBeLessThanOrEqual(24_000);
    expect(page.variants_completion).toEqual({
      complete: false,
      next_cursor: 'remaining-variants',
    });
    const content = wire.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n');
    expect(content).toContain(page.docket_enrichment!.status.replace(/_/g, '\\_'));
    expect(content).not.toContain('private upstream failure');
    for (const chunk of page.retrieval?.text_chunks ?? []) {
      const range = page.retrieval!.ranges.find(
        (range) => range.path === chunk.path && range.unit === 'code_points',
      )!;
      expect(range.start).toBe(Array.from(rebuilt.get(chunk.path) ?? '').length);
      rebuilt.set(chunk.path, (rebuilt.get(chunk.path) ?? '') + chunk.text);
      expect(range.end).toBe(Array.from(rebuilt.get(chunk.path)!).length);
    }
    cursor = page.retrieval?.next_cursor ?? undefined;
    expect(++pages).toBeLessThan(100);
  } while (cursor);
  expect(rebuilt.get('/opinions/0/plain_text')).toBe(texts[0]);
  expect(rebuilt.get('/opinions/1/plain_text')).toBe(texts[1]);
});

it('reconstructs oversized live backfill on independent coordinates and restarts only changed enrichment', async () => {
  let docketNumber = 'number 界😀<&'.repeat(5000);
  const svc = {
    getOpinionCluster: async () => ({
      id: 1,
      docket_id: 10,
      sub_opinions: [{ id: 2, plain_text: 'primary'.repeat(10000) }],
    }),
    getDocketSummary: async () => ({ court_id: 'scotus', docket_number: docketNumber }),
  };
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue(
    svc as unknown as service.CourtListenerService,
  );
  const first = await runToolContract(getOpinionTool, { cluster_id: 1 });
  const outline = getOpinionTool.output.parse(first.structuredContent);
  expect(outline.enrichment_retrieval?.source_id).toHaveLength(64);
  const primaryCursor = outline.retrieval!.next_cursor!;
  let enrichmentCursor = outline.enrichment_retrieval!.next_cursor!;
  let rebuilt = '';
  let pages = 0;
  do {
    const wire = await runToolContract(getOpinionTool, {
      cluster_id: 1,
      cursor: primaryCursor,
      enrichment_cursor: enrichmentCursor,
    });
    expect(wire.isError, JSON.stringify(wire)).not.toBe(true);
    const page = getOpinionTool.output.parse(wire.structuredContent);
    expect(Buffer.byteLength(JSON.stringify(wire.structuredContent))).toBeLessThanOrEqual(24_000);
    expect(Buffer.byteLength(JSON.stringify(wire.content))).toBeLessThanOrEqual(24_000);
    const live = page.enrichment_retrieval!;
    expect(live.source_id).toBe(outline.enrichment_retrieval!.source_id);
    for (const chunk of live.text_chunks) {
      if (chunk.path !== '/docket_number') continue;
      const range = live.ranges.find(
        (range) => range.path === chunk.path && range.unit === 'code_points',
      )!;
      expect(range.start).toBe(Array.from(rebuilt).length);
      rebuilt += chunk.text;
      expect(range.end).toBe(Array.from(rebuilt).length);
      const text = wire.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n');
      expect(text).toContain('/enrichment\\_retrieval/source\\_id');
    }
    enrichmentCursor = live.next_cursor ?? '';
    expect(++pages).toBeLessThan(100);
  } while (enrichmentCursor);
  expect(rebuilt).toBe(docketNumber);
  docketNumber = 'changed '.repeat(9000);
  const changed = await runToolContract(getOpinionTool, {
    cluster_id: 1,
    cursor: primaryCursor,
    enrichment_cursor: outline.enrichment_retrieval!.next_cursor!,
  });
  expect(changed.isError, JSON.stringify(changed)).not.toBe(true);
  const restarted = getOpinionTool.output.parse(changed.structuredContent);
  expect(restarted.enrichment_retrieval!.source_id).not.toBe(
    outline.enrichment_retrieval!.source_id,
  );
  expect(restarted.enrichment_retrieval!.ranges[0]?.start).toBe(0);
  const replay = getOpinionTool.output.parse(
    (await runToolContract(getOpinionTool, { cluster_id: 1, cursor: primaryCursor }))
      .structuredContent,
  );
  expect(restarted.retrieval).toEqual(replay.retrieval);
});

it('walks multiple primary catalog and data pages despite changing enrichment', async () => {
  const opinions = Array.from({ length: 450 }, (_, index) => ({
    id: index + 2,
    plain_text: `variant ${index}`,
  }));
  let request = 0;
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getOpinionCluster: async () => ({ id: 1, docket_id: 10, sub_opinions: opinions }),
    getDocketSummary: async () => {
      if (request++ % 2) throw new Error('unavailable');
      return { court_id: '', docket_number: 'long'.repeat(4000) };
    },
  } as unknown as service.CourtListenerService);
  const rebuilt = new Map<number, string>();
  let cursor: string | undefined;
  let catalogs = 0;
  let data = 0;
  do {
    const wire = await runToolContract(getOpinionTool, { cluster_id: 1, cursor });
    expect(wire.isError, JSON.stringify(wire)).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(wire.structuredContent))).toBeLessThanOrEqual(24_000);
    expect(Buffer.byteLength(JSON.stringify(wire.content))).toBeLessThanOrEqual(24_000);
    const page = getOpinionTool.output.parse(wire.structuredContent);
    if (page.kind === 'outline') catalogs++;
    else data++;
    for (const opinion of page.opinions ?? []) {
      expect(rebuilt.has(opinion.id)).toBe(false);
      rebuilt.set(opinion.id, opinion.plain_text!);
    }
    cursor = page.retrieval?.next_cursor ?? undefined;
    expect(catalogs + data).toBeLessThan(100);
  } while (cursor);
  expect(catalogs).toBeGreaterThan(1);
  expect(data).toBeGreaterThan(1);
  expect([...rebuilt]).toEqual(opinions.map((opinion) => [opinion.id, opinion.plain_text]));
});

it('bounds both final surfaces for explicitly selected CJK transcripts', async () => {
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getOralArgument: async () => ({ id: 1, stt_transcript: '界😀*_'.repeat(10_000) }),
  } as unknown as service.CourtListenerService);
  const wire = await runToolContract(getOralArgumentTool, { id: 1, sections: ['transcript'] });
  expect(wire.isError).not.toBe(true);
  expect(Buffer.byteLength(JSON.stringify(wire.structuredContent))).toBeLessThanOrEqual(24_000);
  expect(Buffer.byteLength(JSON.stringify(wire.content))).toBeLessThanOrEqual(24_000);
  expect(wire.structuredContent).toMatchObject({
    kind: 'outline',
    retrieval: { next_cursor: expect.any(String) },
  });
});

it('derives readable legal text and safely fences raw source', async () => {
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getOpinionCluster: async () => ({
      id: 1,
      sub_opinions: [
        {
          id: 2,
          plain_text: '',
          xml_harvard:
            '<opinion><p>A &amp; B</p><footnote>Note *one*</footnote><table><tr><td>C</td><td>D</td></tr></table></opinion>',
        },
      ],
    }),
  } as unknown as service.CourtListenerService);
  const wire = await runToolContract(getOpinionTool, { cluster_id: 1 });
  expect(wire.structuredContent).toMatchObject({
    opinions: [{ plain_text: expect.stringContaining('A & B') }],
  });
  const content = wire.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
  expect(content).toContain('```');
  expect(content).toContain('Note \\*one\\*');
});

it('exhausts selected audio text and metadata exactly at the completed content boundary', async () => {
  const transcript = '界😀*<&_'.repeat(5000);
  const caseName = '<'.repeat(7000);
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getOralArgument: async () => ({ id: 1, case_name: caseName, stt_transcript: transcript }),
  } as unknown as service.CourtListenerService);
  const result = await walk((cursor) =>
    runToolContract(getOralArgumentTool, { id: 1, sections: ['transcript'], cursor }),
  );
  expect(result.chunks.get('/transcript')).toBe(transcript);
  expect(result.chunks.get('/case_name')).toBe(caseName);
  expect(result.pages[0]?.kind).toBe('outline');
  expect(result.pages.at(-1)).toMatchObject({
    retrieval: { next_cursor: null },
    has_transcript: true,
  });
  expect(result.maxContent).toBe(23_999);
});

it('reconstructs metadata-only opinion overflow, a string-array entry, raw source and completion', async () => {
  const raw = `<opinion><head><title>Metadata</title><p>Legal &amp; readable.</p></head><footnote label="1">Note</footnote>${'<p>界😀*</p>'.repeat(3000)}</opinion>`;
  const syllabus = 'syllabus '.repeat(5000);
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getOpinionCluster: async () => ({
      id: 1,
      syllabus,
      citations: [{ volume: '1', reporter: 'reporter'.repeat(5000), page: '2' }],
      variants_completion: { complete: false, next_cursor: 'upstream-variants' },
      sub_opinions: [{ id: 2, xml_harvard: raw }],
    }),
  } as unknown as service.CourtListenerService);
  const result = await walk((cursor) =>
    runToolContract(getOpinionTool, { cluster_id: 1, sections: ['opinion_2'], cursor }),
  );
  expect(result.chunks.get('/syllabus')).toBe(syllabus);
  expect(result.chunks.get('/citations/0')).toBe(`1 ${'reporter'.repeat(5000)} 2`);
  expect(result.chunks.get('/opinions/0/html_text')).toBe(raw);
  expect(result.chunks.get('/opinions/0/plain_text')).toBe(readableText(raw));
  for (const page of result.pages)
    expect(page.variants_completion).toEqual({ complete: false, next_cursor: 'upstream-variants' });
});

it('pages a giant disclosure row and keeps typed identity and later categories', async () => {
  const description = '界😀&*_'.repeat(5000);
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getFinancialDisclosure: async () => ({
      id: 1,
      investments: [{ id: 7, description }],
      debts: [],
      positions: [],
      reimbursements: [],
      non_investment_incomes: [],
      spouse_incomes: [],
      agreements: [],
      gifts: [{ description: 'gift', source: 'source', value: 'value' }],
    }),
  } as unknown as service.CourtListenerService);
  const result = await walk((cursor) =>
    runToolContract(getFinancialDisclosureTool, { disclosure_id: 1, cursor }),
  );
  expect(result.chunks.get('/investments/0/description')).toBe(description);
  expect(
    result.pages.some((page) => (page.investments as { id: number }[] | undefined)?.[0]?.id === 7),
  ).toBe(true);
  expect(result.pages.at(-1)?.gifts).toEqual([
    { description: 'gift', source: 'source', value: 'value' },
  ]);
});

it('rejects bound/malformed cursors before I/O and stale records with a restart hint', async () => {
  const fetch = vi.fn().mockResolvedValue({ id: 1, stt_transcript: 'x'.repeat(40_000) });
  vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
    getOralArgument: fetch,
  } as unknown as service.CourtListenerService);
  const first = await runToolContract(getOralArgumentTool, { id: 1 });
  const cursor = (first.structuredContent as { retrieval: { next_cursor: string } }).retrieval
    .next_cursor;
  fetch.mockClear();
  for (const input of [
    { id: 2, cursor },
    { id: 1, cursor, sections: ['transcript'] },
    { id: 1, cursor: '!' },
  ]) {
    const wire = await runToolContract(getOralArgumentTool, input);
    expect(wire).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          data: {
            reason: 'invalid_cursor',
            recovery: { hint: expect.stringContaining('Restart') },
          },
        },
      },
    });
  }
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockResolvedValue({ id: 1, stt_transcript: 'changed' });
  expect(
    await runToolContract(
      getOralArgumentTool,
      { id: 1, cursor },
      { context: { tenantId: 'cold-replay' } },
    ),
  ).toMatchObject({
    isError: true,
    structuredContent: { error: { data: { reason: 'stale_cursor' } } },
  });
  expect(
    await runToolContract(
      getOralArgumentTool,
      { id: 1 },
      { context: { signal: AbortSignal.abort() } },
    ),
  ).toMatchObject({ isError: true, structuredContent: { error: { code: -32011 } } });
});

it('retains legal blocks, entities, literal text and nested hidden metadata boundaries', () => {
  expect(readableText('<head><title>Title</title><p>Legal text</p>')).toBe('Legal text');
  expect(
    readableText('<template>hidden<style>css</style>still hidden</template><p>Visible</p>'),
  ).toBe('Visible');
  const text = readableText(
    '<p>A &amp;amp; B &lt; C</p><ol><li>First</li><li>Second</li></ol><footnote label="2">note</footnote><table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>',
  );
  expect(text).toContain('A &amp; B < C');
  expect(text).toContain('• First\n\n• Second');
  expect(text).toContain('[2] note');
  expect(text).toContain('A\tB\n\nC\tD');
  expect(fenceSource('```\nraw')).toBe('\n````text\n```\nraw\n````\n');
});

it.each(['search', 'citations'])(
  'normalizes %s snippets without structured rendering escapes',
  async (name) => {
    const data = {
      total: 1,
      nextCursor: null,
      sourceCaseName: 'Source',
      results: [
        {
          cluster_id: 2,
          opinions: [{ id: 3, snippet: '<mark>A &amp; B</mark> *literal* &lt; C' }],
        },
      ],
    };
    vi.spyOn(service, 'getCourtListenerService').mockReturnValue({
      searchOpinions: async () => data,
      getCitedBy: async () => data,
    } as unknown as service.CourtListenerService);
    const wire =
      name === 'search'
        ? await runToolContract(searchOpinionsTool, { q: 'text' })
        : await runToolContract(getCitationsTool, { cluster_id: 1 });
    expect(wire.isError).not.toBe(true);
    expect(wire.structuredContent).toMatchObject({ results: [{ snippet: 'A & B *literal* < C' }] });
    const text = wire.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    expect(text).toContain('A &amp; B \\*literal\\* &lt; C');
    expect(text).not.toContain('<mark>');
  },
);
