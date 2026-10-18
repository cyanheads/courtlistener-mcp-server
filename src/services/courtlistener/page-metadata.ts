/**
 * @fileoverview Bounded page request and upstream completion contracts.
 * @module services/courtlistener/page-metadata
 */
import { z } from '@cyanheads/mcp-ts-core';

/** Completion of a bounded source walk, independent of response paging. */
export const Completion = z
  .object({
    complete: z.boolean().describe('True only when all source variants were fetched.'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Remaining upstream variant cursor; null at the end.'),
  })
  .describe('Completion of the source opinion-variant walk.');

/** Page accounting preserves upstream pages even when a requested size is ignored. */
export const PageSizing = z
  .object({
    requested: z.number().describe('Caller-requested page size.'),
    bounded: z.number().describe('Size sent upstream or used for the cited-ID slice.'),
    actual: z.number().describe('Rows returned to the caller after any page-local filters.'),
    upstream: z
      .enum(['minimum_20', 'fixed_20', 'cited_id_slice'])
      .describe(
        'Upstream minimum, fixed page, or cited-ID slicing policy; final pages may contain fewer rows.',
      ),
  })
  .describe('Requested, bounded, and actual page sizes.');

/** Build constant-size accounting without changing rows or continuation. */
export function pageSizing(
  requested: number,
  cap: number,
  actual: number,
  upstream: z.infer<typeof PageSizing>['upstream'],
) {
  return { requested, bounded: Math.min(requested, cap), actual, upstream };
}

/** Render the same page accounting on text-only clients. */
export function formatPageSizing(value: z.infer<typeof PageSizing> | undefined): string {
  return value
    ? `**Page sizing:** requested ${value.requested}; bounded ${value.bounded}; actual ${value.actual}; upstream ${value.upstream}.`
    : '';
}
