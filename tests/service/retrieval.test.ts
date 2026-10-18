/**
 * @fileoverview Exact bounded retrieval reconstruction and cursor contracts.
 * @module tests/service/retrieval.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { expect, it } from 'vitest';
import {
  formatRetrievalPage,
  Retrieval,
  readRetrievalCursor,
  retrieve,
} from '@/services/courtlistener/retrieval.js';

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
type View = { [key: string]: Value };
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const output = z.object({
  id: z.number(),
  label: z.string().optional(),
  more: z.string().optional(),
  rows: z
    .array(
      z.object({
        id: z.number(),
        text: z.string().optional(),
        ids: z.array(z.number()).optional(),
      }),
    )
    .optional(),
  kind: z.enum(['full', 'outline', 'page']),
  retrieval: Retrieval,
  sections: z.array(z.object({ name: z.string(), bytes: z.number() })).optional(),
  retrieval_notice: z.string().optional(),
});

function finalize(value: unknown) {
  const parsed = output.parse(value);
  return {
    structuredContent: parsed,
    content: [
      ...formatRetrievalPage(parsed),
      { type: 'text', text: 'Additional trailer. '.repeat(100) },
    ],
  };
}

/** Reassemble by absolute pointers, rebasing compact page arrays through row ranges. */
function mergePage(target: View, page: View) {
  const retrieval = page.retrieval as unknown as NonNullable<z.infer<typeof Retrieval>> | undefined;
  const ranges = retrieval?.ranges ?? [];
  const assign = (path: string, value: Value) => {
    const keys = path
      .slice(1)
      .split('/')
      .map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    let current: View | Value[] = target;
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index] as string;
      if (index === keys.length - 1) {
        (current as View)[key] = value;
        return;
      }
      (current as View)[key] ??= /^\d+$/.test(keys[index + 1] as string) ? [] : {};
      current = (current as View)[key] as View;
    }
  };
  const visit = (value: Value, path: string) => {
    if (Array.isArray(value)) {
      if (!value.length) assign(path, []);
      const first = ranges
        .filter((range) => range.path === path && range.unit === 'rows')
        .reduce((min, range) => Math.min(min, range.start), Infinity);
      value.forEach((item, index) => {
        visit(item, `${path}/${index + (first === Infinity ? 0 : first)}`);
      });
    } else if (value && typeof value === 'object') {
      if (!Object.keys(value).length) assign(path, {});
      for (const [key, item] of Object.entries(value))
        visit(item, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`);
    } else assign(path, value);
  };
  for (const [key, value] of Object.entries(page))
    if (!['retrieval', 'sections', 'retrieval_notice', 'kind'].includes(key))
      visit(value, `/${key}`);
  for (const chunk of retrieval?.text_chunks ?? []) {
    const range = ranges.find((range) => range.path === chunk.path && range.unit === 'code_points');
    expect(range).toBeDefined();
    expect(Array.from(chunk.text)).toHaveLength((range?.end ?? 0) - (range?.start ?? 0));
    const keys = chunk.path.slice(1).split('/');
    let previous: Value | undefined = target;
    for (const key of keys) previous = (previous as View | undefined)?.[key];
    expect(Array.from(typeof previous === 'string' ? previous : '')).toHaveLength(
      range?.start ?? 0,
    );
    assign(chunk.path, (typeof previous === 'string' ? previous : '') + chunk.text);
  }
}

function walk(view: View, groups = [{ name: 'rows', value: view.rows }]) {
  const rebuilt: View = {};
  const pages: ReturnType<typeof retrieve>[] = [];
  let token: string | undefined;
  const seen = new Set<string>();
  do {
    const page = retrieve({
      tool: 'test',
      id: 1,
      view,
      groups,
      required: ['id'],
      cursor: readRetrievalCursor(token, 'test', 1),
      finalize,
    });
    const wire = finalize(page);
    expect(size(wire.structuredContent)).toBeLessThanOrEqual(24_000);
    expect(size(wire.content)).toBeLessThanOrEqual(24_000);
    pages.push(page);
    mergePage(rebuilt, page as unknown as View);
    const next = page.retrieval?.next_cursor;
    token = next ?? undefined;
    if (token) {
      expect(seen.has(token)).toBe(false);
      seen.add(token);
    }
    expect(pages.length).toBeLessThan(1000);
  } while (token);
  expect(rebuilt).toEqual(view);
  return pages;
}

it('reconstructs multiple partial rows, nested numeric arrays and Unicode text with trailers', () => {
  const pages = walk({
    id: 1,
    label: '界😀<*_'.repeat(5000),
    more: 'tail',
    rows: [
      { id: 1, text: 'first', ids: Array.from({ length: 4000 }, (_, index) => index) },
      { id: 2, text: '界😀*<'.repeat(7000), ids: [5] },
      { id: 3, text: 'last', ids: [] },
    ],
  });
  expect(pages.length).toBeGreaterThan(5);
});

it('bounds collectively expanded small metadata and escapes raw-source fence delimiters', () => {
  walk({
    id: 1,
    label: '<'.repeat(1000),
    more: '<'.repeat(1000),
    rows: [{ id: 2, text: '`'.repeat(9000) }],
  });
});

it('pages a catalog through data and preserves deterministic replay', () => {
  const rows = Array.from({ length: 450 }, (_, id) => ({ id, text: 'x'.repeat(80) }));
  const view = { id: 1, rows };
  const groups = rows.map((row) => ({ name: `opinion_${row.id}`, value: row }));
  // The opinion descriptors refer to the typed opinions array in production.
  const schema = z.object({
    id: z.number(),
    opinions: output.shape.rows,
    kind: output.shape.kind,
    retrieval: Retrieval,
    sections: output.shape.sections,
    retrieval_notice: output.shape.retrieval_notice,
  });
  const finish = (value: unknown) => {
    const parsed = schema.parse(value);
    return { structuredContent: parsed, content: formatRetrievalPage(parsed) };
  };
  let token: string | undefined;
  let outlines = 0;
  let data = 0;
  const rebuilt: View = {};
  do {
    const options = {
      tool: 'test',
      id: 1,
      view: { id: view.id, opinions: rows },
      groups,
      required: ['id'],
      cursor: readRetrievalCursor(token, 'test', 1),
      finalize: finish,
    };
    const page = retrieve(options);
    expect(retrieve(options)).toEqual(page);
    const wire = finish(page);
    expect(size(wire.structuredContent)).toBeLessThanOrEqual(24_000);
    expect(size(wire.content)).toBeLessThanOrEqual(24_000);
    if (page.kind === 'outline') outlines++;
    else data++;
    mergePage(rebuilt, page as unknown as View);
    token = page.retrieval?.next_cursor ?? undefined;
  } while (token);
  expect(outlines).toBeGreaterThan(1);
  expect(data).toBeGreaterThan(1);
  expect(rebuilt).toEqual({ id: 1, opinions: rows });
});

it('rejects stale, cross-request, malformed and past-end cursors and propagates cancellation', () => {
  const view = { id: 1, rows: [{ id: 1, text: 'x'.repeat(40_000) }] };
  const options = {
    tool: 'test',
    id: 1,
    view,
    groups: [{ name: 'rows', value: view.rows }],
    required: ['id'],
    finalize,
  };
  const page = retrieve(options);
  const token = page.retrieval?.next_cursor as string;
  const cursor = readRetrievalCursor(token, 'test', 1);
  expect(() => readRetrievalCursor(token, 'test', 2)).toThrow();
  expect(() => readRetrievalCursor(token, 'test', 1, ['rows'])).toThrow();
  for (const value of ['', '!', 'x'.repeat(1025)])
    expect(() => readRetrievalCursor(value, 'test', 1)).toThrow();
  expect(() => retrieve({ ...options, cursor, view: { ...view, id: 2 } })).toThrow(
    /source changed/,
  );
  expect(() =>
    retrieve({ ...options, cursor: { ...cursor!, phase: 'data', index: 9999 } }),
  ).toThrow(/Invalid retrieval cursor/);
  expect(() => retrieve({ ...options, signal: AbortSignal.abort() })).toThrow(/cancelled/);
});

it('leaves small and empty responses full without retrieval metadata', () => {
  expect(walk({ id: 1, rows: [] })).toHaveLength(1);
  expect(walk({ id: 1, rows: [{ id: 2, text: '' }] })[0]).toMatchObject({ kind: 'full' });
});

it('renders absolute row and catalog paths on later pages, including nested arrays', () => {
  const content = formatRetrievalPage({
    kind: 'page',
    rows: [{ id: 5, ids: [42] }],
    sections: [{ name: 'later', bytes: 1 }],
    retrieval: {
      next_cursor: null,
      ranges: [
        { path: '/rows', unit: 'rows', start: 10, end: 11, total: 20 },
        { path: '/rows/10/ids', unit: 'rows', start: 12, end: 13, total: 30 },
        { path: '/sections', unit: 'sections', start: 15, end: 16, total: 40 },
      ],
      text_chunks: [],
    },
  });
  expect(content[0]?.text).toContain('/rows/10/id');
  expect(content[0]?.text).toContain('/rows/10/ids/12');
  expect(content[0]?.text).toContain('/sections/15/name');
});
