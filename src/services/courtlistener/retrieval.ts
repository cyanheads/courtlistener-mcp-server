/**
 * @fileoverview Stateless bounded retrieval of normalized CourtListener records.
 * @module services/courtlistener/retrieval
 */
import { createHash } from 'node:crypto';
import { z } from '@cyanheads/mcp-ts-core';
import { requestCancelled, validationError } from '@cyanheads/mcp-ts-core/errors';
import { escapeText, fenceSource } from './readable-text.js';

/** Independent ceiling for each completed serialized MCP success surface. */
export const RETRIEVAL_BYTES = 24_000;

/** Cursor is a bounded position, bound to the original request and normalized view. */
export const RetrievalCursor = z
  .string()
  .max(1024)
  .optional()
  .describe(
    'Retrieval next_cursor from the previous response. Repeat the original ID and sections/categories selection unchanged; omit to start.',
  );

/** Explicit source coordinates for typed rows, text slices and catalog pages. */
export const Retrieval = z
  .object({
    next_cursor: z
      .string()
      .nullable()
      .describe(
        'Continue with cursor and the same ID/selection; null when this fetched view is exhausted.',
      ),
    ranges: z
      .array(
        z
          .object({
            path: z.string().describe('JSON Pointer into the normalized unsliced selected view.'),
            unit: z.enum(['rows', 'code_points', 'sections']).describe('Coordinate unit.'),
            start: z.number().int().describe('Inclusive absolute start.'),
            end: z.number().int().describe('Exclusive absolute end.'),
            total: z
              .number()
              .int()
              .describe('Length of the complete normalized collection or text field.'),
          })
          .describe('Source range.'),
      )
      .describe(
        'Absolute source coordinates; merge typed rows by index rather than appending duplicates.',
      ),
    text_chunks: z
      .array(
        z
          .object({
            path: z
              .string()
              .describe('JSON Pointer of the original string field or string-array element.'),
            text: z
              .string()
              .describe('Unescaped normalized substring, matching its code_points range.'),
          })
          .describe('Readable string slice.'),
      )
      .describe(
        'Text omitted from partial rows/metadata, recoverable exactly using the matching ranges.',
      ),
  })
  .optional()
  .describe('Caller retrieval completion, separate from upstream source completion.');

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };
type RecordView = { [key: string]: Json | undefined };
type Range = NonNullable<z.infer<typeof Retrieval>>['ranges'][number];
type Position = { phase: 'catalog' | 'data'; index: number; offset: number };
type Cursor = Position & { v: 1; binding: string; digest: string };
type Row = { path: string; index: number; total: number };
type TextIndex = { total: number; checkpoints: number[] };
type Unit = { path: string; value: Json; rows: Row[]; text?: TextIndex };
type Descriptor = { name: string; bytes: number };

const CursorShape = z
  .object({
    v: z.literal(1),
    binding: z.string().length(64),
    digest: z.string().length(64),
    phase: z.enum(['catalog', 'data']),
    index: z.number().int().nonnegative().safe(),
    offset: z.number().int().nonnegative().safe(),
  })
  .strict();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const pointer = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
const binding = (tool: string, id: number, selection?: string[]) =>
  hash([tool, id, selection?.length ? [...new Set(selection)].sort() : null]);

/** Sparse UTF-16 positions keep seeking bounded without copying each source character. */
function indexText(value: string): TextIndex {
  const checkpoints: number[] = [];
  let total = 0;
  for (let offset = 0; offset < value.length; total++) {
    if (total % 1024 === 0) checkpoints.push(offset);
    offset += (value.codePointAt(offset) as number) > 0xffff ? 2 : 1;
  }
  return { total, checkpoints };
}

function textOffset(value: string, index: TextIndex, position: number): number {
  if (position === index.total) return value.length;
  let offset = index.checkpoints[Math.floor(position / 1024)] as number;
  for (let point = Math.floor(position / 1024) * 1024; point < position; point++)
    offset += (value.codePointAt(offset) as number) > 0xffff ? 2 : 1;
  return offset;
}

function invalidCursor(): never {
  throw validationError(
    'Invalid retrieval cursor. Restart without cursor using the original ID and selection.',
    { reason: 'invalid_cursor' },
  );
}

/** Reject malformed/cross-request cursors before any upstream request. */
export function readRetrievalCursor(
  token: string | undefined,
  tool: string,
  id: number,
  selection?: string[],
): Cursor | undefined {
  if (token === undefined) return undefined;
  if (!token || token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) return invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return invalidCursor();
  }
  const parsed = CursorShape.safeParse(decoded);
  if (!parsed.success || parsed.data.binding !== binding(tool, id, selection))
    return invalidCursor();
  return parsed.data;
}

/** Render every field of a bounded page, with safe source-markup fencing. */
export function formatRetrievalPage(result: object): { type: 'text'; text: string }[] {
  const lines: string[] = [`**Response mode:** ${(result as { kind?: string }).kind}`];
  const retrieval = (result as { retrieval?: NonNullable<z.infer<typeof Retrieval>> }).retrieval;
  const starts = new Map<string, number>();
  for (const range of retrieval?.ranges ?? []) {
    if (range.unit === 'rows' || range.unit === 'sections')
      starts.set(range.path, Math.min(starts.get(range.path) ?? range.start, range.start));
  }
  const visit = (value: unknown, path: string) => {
    if (value === undefined) return;
    if (typeof value === 'string') {
      lines.push(
        `**${escapeText(path)}:** ${path.endsWith('/html_text') ? fenceSource(value) : escapeText(value)}`,
      );
    } else if (Array.isArray(value)) {
      if (path === '/sections') lines.push(`${value.length} sections available`);
      if (!value.length) lines.push(`**${escapeText(path)}:** []`);
      value.forEach((item, index) => {
        visit(item, `${path}/${index + (starts.get(path) ?? 0)}`);
      });
    } else if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (!entries.length) lines.push(`**${escapeText(path)}:** {}`);
      for (const [key, item] of entries) visit(item, `${path}/${pointer(key)}`);
    } else lines.push(`**${escapeText(path)}:** ${String(value)}`);
  };
  for (const [key, value] of Object.entries(result)) {
    if (key === 'retrieval' && value) {
      const retrieval = value as NonNullable<z.infer<typeof Retrieval>>;
      for (const range of retrieval.ranges)
        lines.push(
          `**Range:** ${escapeText(range.path)} ${range.unit} ${range.start}:${range.end}/${range.total}`,
        );
      for (const chunk of retrieval.text_chunks)
        lines.push(
          `**${escapeText(chunk.path)}:** ${chunk.path.endsWith('/html_text') ? fenceSource(chunk.text) : escapeText(chunk.text)}`,
        );
      lines.push(`**retrieval.next_cursor:** ${retrieval.next_cursor ?? 'null'}`);
    } else visit(value, `/${pointer(key)}`);
  }
  return [{ type: 'text', text: lines.join('\n\n') }];
}

/** Produce bounded outline/page responses while preserving the tool's domain types. */
export function retrieve<T extends object>(options: {
  tool: string;
  id: number;
  selection?: string[] | undefined;
  cursor?: Cursor | undefined;
  view: T;
  groups: { name: string; value: unknown }[];
  required: string[];
  signal?: AbortSignal | undefined;
  finalize: (value: unknown) => { structuredContent: object; content: unknown[] };
}): T & {
  kind: 'full' | 'outline' | 'page';
  retrieval?: NonNullable<z.infer<typeof Retrieval>>;
  sections?: Descriptor[];
  retrieval_notice?: string;
} {
  const { view, cursor, signal } = options;
  const checkCancellation = () => {
    if (signal?.aborted) throw requestCancelled('Retrieval cancelled.');
  };
  checkCancellation();
  const source = view as RecordView;
  const digest = hash(view);
  if (cursor && cursor.digest !== digest)
    throw validationError(
      'The normalized source changed. Restart without cursor using the original ID and selection.',
      { reason: 'stale_cursor' },
    );
  const fits = (value: object, limit = RETRIEVAL_BYTES) => {
    checkCancellation();
    const wire = options.finalize(value);
    return bytes(wire.structuredContent) <= limit && bytes(wire.content) <= limit;
  };
  const full = { ...view, kind: 'full' as const };
  if (!cursor && fits(full)) return full;

  const base: RecordView = {};
  const units: Unit[] = [];
  const skeletons = new Map<string, RecordView>();
  const descriptors: Descriptor[] = [];
  const groupKeys = new Set(
    options.groups.map((group) => (group.name.startsWith('opinion_') ? 'opinions' : group.name)),
  );
  const add = (path: string, value: Json, rows: Row[] = []) => {
    checkCancellation();
    if (Array.isArray(value)) {
      if (!value.length) units.push({ path, value, rows });
      value.forEach((item, index) => {
        add(`${path}/${index}`, item, [...rows, { path, index, total: value.length }]);
      });
    } else if (
      value &&
      typeof value === 'object' &&
      (bytes(value) > 3000 ||
        Object.values(value).some((child) => Array.isArray(child) && bytes(child) > 256))
    ) {
      const skeleton: RecordView = {};
      const deferred: [string, Json][] = [];
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) continue;
        if ((typeof child === 'string' || Array.isArray(child)) && bytes(child) > 256)
          deferred.push([key, child]);
        else skeleton[key] = child;
      }
      skeletons.set(path, skeleton);
      units.push({ path, value: skeleton, rows });
      for (const [key, child] of deferred) add(`${path}/${pointer(key)}`, child, rows);
    } else
      units.push({
        path,
        value,
        rows,
        ...(typeof value === 'string' && bytes(value) > 256 ? { text: indexText(value) } : {}),
      });
  };
  for (const key of options.required) {
    const value = source[key];
    if (value && !Array.isArray(value) && typeof value === 'object' && bytes(value) > 1024) {
      // Required completion booleans stay inline; an oversized source cursor is a
      // normal string field with an explicit omission in the tool's page schema.
      base[key] = Object.fromEntries(
        Object.entries(value).filter(([, child]) => typeof child !== 'string'),
      );
      descriptors.push({ name: key, bytes: bytes(value) });
      add(`/${pointer(key)}`, value);
    } else base[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || groupKeys.has(key)) continue;
    if (options.required.includes(key)) continue;
    // Keep room for coordinates and source data even when many small metadata
    // fields expand in presentation. Every deferred field enters the same stream.
    if (
      bytes(value) <= 1024 &&
      fits(
        {
          ...base,
          [key]: value,
          kind: 'page',
          retrieval: { next_cursor: null, ranges: [], text_chunks: [] },
        },
        6000,
      )
    )
      base[key] = value;
    else {
      descriptors.push({ name: key, bytes: bytes(value) });
      add(`/${pointer(key)}`, value);
    }
  }
  for (const group of options.groups)
    descriptors.push({ name: group.name, bytes: bytes(group.value) });
  for (const key of groupKeys) {
    const value = source[key];
    if (value !== undefined) add(`/${pointer(key)}`, value);
  }

  const requestBinding = binding(options.tool, options.id, options.selection);
  const nextToken = (position: Position | null) =>
    position === null
      ? null
      : Buffer.from(
          JSON.stringify({
            v: 1,
            binding: requestBinding,
            digest,
            ...position,
          }),
        ).toString('base64url');
  const notice =
    'Continue with cursor: retrieval.next_cursor, the same ID and the same sections/categories selection. Merge rows by absolute ranges and concatenate text_chunks by their code_points ranges. Source completion is independent.';
  const response = (
    kind: 'outline' | 'page',
    position: Position | null,
    ranges: Range[],
    chunks: { path: string; text: string }[],
    extra: RecordView = {},
  ) => ({
    ...base,
    ...extra,
    kind,
    retrieval: { next_cursor: nextToken(position), ranges, text_chunks: chunks },
  });
  const dataStart = (): Position | null =>
    units.length ? { phase: 'data', index: 0, offset: 0 } : null;
  let position: Position = cursor ?? { phase: 'catalog', index: 0, offset: 0 };
  if (position.phase === 'catalog') {
    if (position.offset !== 0 || position.index >= descriptors.length) return invalidCursor();
    const start = position.index;
    const sections: Descriptor[] = [];
    let last: object | undefined;
    while (position.index < descriptors.length) {
      const descriptor = descriptors[position.index];
      if (!descriptor) break;
      const next: Position | null =
        position.index + 1 < descriptors.length
          ? { phase: 'catalog', index: position.index + 1, offset: 0 }
          : dataStart();
      const candidate = {
        ...response(
          'outline',
          next,
          [
            {
              path: '/sections',
              unit: 'sections',
              start,
              end: position.index + 1,
              total: descriptors.length,
            },
          ],
          [],
        ),
        sections: [...sections, descriptor],
        retrieval_notice: notice,
      };
      if (!fits(candidate)) break;
      sections.push(descriptor);
      position = { ...position, index: position.index + 1 };
      last = candidate;
    }
    if (!last) throw new Error('Retrieval catalog envelope exceeds the response bound.');
    return last as ReturnType<typeof retrieve<T>>;
  }
  if (position.index >= units.length) return invalidCursor();
  let extra: RecordView = {};
  let ranges: Range[] = [];
  let chunks: { path: string; text: string }[] = [];
  let last: object | undefined;
  const setValue = (target: RecordView, unit: Unit, rowStarts: Map<string, number>) => {
    const keys = unit.path
      .slice(1)
      .split('/')
      .map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    let object: RecordView | Json[] = target;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i] as string;
      const index = Array.isArray(object)
        ? Number(key) - (rowStarts.get(`/${keys.slice(0, i).map(pointer).join('/')}`) ?? 0)
        : key;
      if (i === keys.length - 1) {
        (object as RecordView)[index] = unit.value;
        break;
      }
      const nextKey = keys[i + 1] as string;
      const prefix = `/${keys
        .slice(0, i + 1)
        .map(pointer)
        .join('/')}`;
      if (/^\d+$/.test(nextKey) && !rowStarts.has(prefix)) rowStarts.set(prefix, Number(nextKey));
      if ((object as RecordView)[index] === undefined)
        (object as RecordView)[index] = /^\d+$/.test(nextKey) ? [] : { ...skeletons.get(prefix) };
      object = (object as RecordView)[index] as RecordView | Json[];
    }
  };
  while (position.index < units.length) {
    checkCancellation();
    const unit = units[position.index] as Unit;
    const text = unit.text;
    if (!text && position.offset !== 0) return invalidCursor();
    if (text && position.offset >= text.total) return invalidCursor();
    const nextPosition = (end: number): Position | null =>
      text && end < text.total
        ? { phase: 'data', index: position.index, offset: end }
        : position.index + 1 < units.length
          ? { phase: 'data', index: position.index + 1, offset: 0 }
          : null;
    const attempt = (count: number) => {
      const candidateExtra = structuredClone(extra);
      const candidateRanges = [...ranges];
      const candidateChunks = [...chunks];
      let end = 0;
      if (text) {
        end = position.offset + count;
        candidateRanges.push({
          path: unit.path,
          unit: 'code_points',
          start: position.offset,
          end,
          total: text.total,
        });
        const value = unit.value as string;
        candidateChunks.push({
          path: unit.path,
          text: value.slice(textOffset(value, text, position.offset), textOffset(value, text, end)),
        });
      } else {
        const starts = new Map<string, number>();
        for (const range of candidateRanges)
          if (range.unit === 'rows' && !starts.has(range.path)) starts.set(range.path, range.start);
        setValue(candidateExtra, unit, starts);
      }
      if (!text)
        for (const row of unit.rows)
          if (
            !candidateRanges.some(
              (range) =>
                range.unit === 'rows' && range.path === row.path && range.start === row.index,
            )
          )
            candidateRanges.push({
              path: row.path,
              unit: 'rows',
              start: row.index,
              end: row.index + 1,
              total: row.total,
            });
      const next = nextPosition(end);
      return {
        extra: candidateExtra,
        ranges: candidateRanges,
        chunks: candidateChunks,
        next,
        output: response('page', next, candidateRanges, candidateChunks, candidateExtra),
      };
    };
    let chosen = attempt(text ? Math.min(text.total - position.offset, RETRIEVAL_BYTES) : 0);
    if (!fits(chosen.output)) {
      if (!text) break;
      let low = 1;
      let high = Math.min(text.total - position.offset, RETRIEVAL_BYTES);
      let best: ReturnType<typeof attempt> | undefined;
      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const trial = attempt(mid);
        if (fits(trial.output)) {
          best = trial;
          low = mid + 1;
        } else high = mid - 1;
      }
      if (!best) break;
      chosen = best;
    }
    extra = chosen.extra;
    ranges = chosen.ranges;
    chunks = chosen.chunks;
    last = chosen.output;
    if (!chosen.next) break;
    position = chosen.next;
    if (text && position.offset > 0) break;
  }
  if (!last) throw new Error('Retrieval data envelope exceeds the response bound.');
  return last as ReturnType<typeof retrieve<T>>;
}
