/**
 * @fileoverview Fetch full docket metadata and entry list for a single federal case.
 * @module mcp-server/tools/definitions/get-docket.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { markdownLink } from '@cyanheads/mcp-ts-core/utils';
import { resolveCourtName } from '@/services/courtlistener/court-names.js';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import {
  formatPageSizing,
  PageSizing,
  pageSizing,
} from '@/services/courtlistener/page-metadata.js';
import {
  formatRetrievalPage,
  Retrieval,
  RetrievalCursor,
  readRetrievalCursor,
  retrieve,
} from '@/services/courtlistener/retrieval.js';
import { readRetrievalSnapshot } from '@/services/courtlistener/retrieval-snapshot.js';
import { idFromUri, toStorageUrl } from '@/services/courtlistener/uri.js';

const SelectedDocument = z.object({
  id: z.number().describe('RECAP document ID.'),
  entry_id: z.number().describe('Owning entry ID, verified against the requested docket.'),
  document_number: z.string().nullable().describe('PACER document number.'),
  attachment_number: z.number().nullable().describe('Attachment number, or null.'),
  description: z.string().describe('Source document description.'),
  is_available: z.boolean().nullable().describe('Source file availability; null means unknown.'),
  page_count: z.number().nullable().describe('Source page count, or null.'),
  filepath_local: z.string().nullable().describe('RECAP storage URL, or null.'),
  source_url: z.string().nullable().describe('CourtListener document source link, or null.'),
  plain_text: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Unmodified extracted source text; omitted if absent upstream or deferred to retrieval.text_chunks.',
    ),
  text_status: z
    .enum(['available', 'unavailable', 'not_extracted', 'unknown'])
    .describe('Text availability independently of source file availability.'),
});

const SelectedDocket = z.object({
  kind: z.enum(['full', 'outline', 'page']).describe('Bounded selected-document retrieval mode.'),
  docket_id: z.number().describe('Requested docket ID.'),
  entries_page: z.number().describe('Entries page containing the selected documents.'),
  next_cursor: z
    .string()
    .nullable()
    .describe(
      'Next entries page as a numeric string; convert to a number for entries_page. Independent of retrieval.next_cursor.',
    ),
  document_ids: z
    .array(z.number())
    .optional()
    .describe(
      'Normalized selected document IDs; deferred oversized selections are recovered through retrieval ranges.',
    ),
  selected_documents: z
    .array(
      SelectedDocument.partial().describe('Selected document or a recoverable partial record.'),
    )
    .optional()
    .describe(
      'Selected source records; partial fields are recovered by retrieval ranges and text_chunks.',
    ),
  sections: z
    .array(
      z
        .object({
          name: z.string().describe('Deferred field group.'),
          bytes: z.number().describe('Serialized source bytes.'),
        })
        .describe('Deferred field group and source size.'),
    )
    .optional()
    .describe('Deferred selected-document groups.'),
  retrieval: Retrieval,
  source_fetched_at: z.iso
    .datetime()
    .optional()
    .describe('UTC time the selected docket source fetch completed.'),
  retrieval_notice: z
    .string()
    .optional()
    .describe('Instructions for reconstructing selected source records.'),
});

export const getDocketTool = tool('courtlistener_get_docket', {
  title: 'Get Docket',
  description:
    'Fetch docket metadata and one entries page by docket ID. Omit document_ids for the docket listing, or select RECAP document IDs embedded on entries_page to retrieve their extracted text without further upstream requests. Selected text uses bounded full/outline/page responses; continue retrieval.next_cursor as cursor with the same docket_id, entries_page and document_ids. Top-level next_cursor remains entries pagination. File availability and extracted-text status are independent. Obtain docket IDs from courtlistener_search_dockets or opinion results.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    document_ids: z
      .array(z.number().int().positive().safe())
      .min(1)
      .optional()
      .describe(
        'Select RECAP document IDs embedded on entries_page. No other pages or document endpoints are fetched; omit for the unchanged docket listing.',
      ),
    cursor: RetrievalCursor,
    docket_id: z
      .number()
      .int()
      .describe(
        "Docket ID from a search result's docket_id field or from an opinion cluster result.",
      ),
    entries_page: z
      .number()
      .int()
      .min(1)
      .optional()
      .default(1)
      .describe(
        'Docket entries use ascending entry number, 20 per page, up to page 100. Pass the numeric value of the top-level next_cursor as entries_page to continue. For a positive total_entries, ceil(total_entries / 20) locates the last page if it is at most 100. A null total gives no last-page calculation. Use filing dates to identify recent filings.',
      ),
    entries_page_size: z
      .number()
      .int()
      .min(1)
      .optional()
      .default(20)
      .describe(
        'Requested docket entries per page. NOTE: CourtListener ignores this value — /docket-entries/ always returns a fixed 20-entry page regardless of what is passed. Use entries_page to reach entries beyond the first 20 (large cases can have hundreds).',
      ),
  }),

  output: z
    .object({
      page_sizing: PageSizing.optional(),
      docket_id: z.number().describe('Docket ID.'),
      case_name: z.string().describe('Short case name.'),
      case_name_full: z.string().describe('Full case name.'),
      court: z
        .string()
        .describe('Court display name for major federal courts; the court identifier otherwise.'),
      court_id: z.string().describe('Court identifier — the stable value for filtering.'),
      date_filed: z.string().describe('Date the case was filed.'),
      cluster_ids: z
        .array(z.number())
        .describe('Linked opinion cluster IDs for courtlistener_get_opinion.'),
      audio_ids: z
        .array(z.number())
        .describe('Linked recording IDs for courtlistener_get_oral_argument.'),
      date_argued: z.string().nullable().describe('Date of oral argument; null if absent.'),
      suit_nature: z.string().nullable().describe('Nature of suit; null if absent.'),
      appeal_from: z.string().nullable().describe('Court or venue appealed from; null if absent.'),
      date_last_filing: z.string().nullable().describe('Date of last filing; null if absent.'),
      date_terminated: z
        .string()
        .nullable()
        .describe('Date the case was terminated; null if active.'),
      docket_number: z.string().describe('Docket number.'),
      pacer_case_id: z.string().nullable().describe('PACER case ID; null if not in RECAP.'),
      assigned_to: z.string().nullable().describe('Assigned judge name; null if not recorded.'),
      referred_to: z.string().nullable().describe('Referred judge name; null if not recorded.'),
      cause: z.string().describe('Legal cause of action.'),
      jury_demand: z.string().describe('Jury demand status.'),
      jurisdiction_type: z.string().describe('Jurisdiction type.'),
      total_entries: z
        .number()
        .nullable()
        .describe(
          'Total number of docket entries available; null when upstream supplies no numeric total. May exceed the returned entries list.',
        ),
      entries_page: z.number().describe('Current entries page number (1-indexed).'),
      next_cursor: z
        .string()
        .nullable()
        .describe(
          'Next entries page as a numeric string; convert to a number for the entries_page argument. Null when this is the last page.',
        ),
      entries: z
        .array(
          z
            .object({
              id: z.number().describe('Docket entry ID.'),
              entry_number: z
                .number()
                .nullable()
                .describe('PACER entry number; null if not assigned.'),
              date_filed: z.string().describe('Date this entry was filed.'),
              description: z.string().describe('Entry description or filing type.'),
              documents: z
                .array(
                  z
                    .object({
                      id: z.number().describe('Document ID.'),
                      document_number: z
                        .string()
                        .nullable()
                        .describe(
                          'PACER document number as a string (e.g. "1"); attachments can be non-integer like "70-1". Null if not assigned.',
                        ),
                      attachment_number: z
                        .number()
                        .nullable()
                        .describe('Attachment number; null for the main document.'),
                      description: z.string().describe('Document description.'),
                      is_available: z
                        .boolean()
                        .describe(
                          'True if the document is available via RECAP without a PACER account.',
                        ),
                      page_count: z
                        .number()
                        .nullable()
                        .describe('Page count; null if not recorded.'),
                      filepath_local: z
                        .string()
                        .nullable()
                        .describe(
                          'Fully-qualified RECAP storage URL (https://storage.courtlistener.com/...) for the document; null if not available.',
                        ),
                    })
                    .describe('Document attached to a docket entry.'),
                )
                .describe('Documents attached to this docket entry.'),
            })
            .describe('Docket entry with attached documents.'),
        )
        .describe(
          'Docket entries for this page (fixed at 20 per page; entries_page_size is not honored by upstream).',
        ),
    })
    .partial()
    .extend({
      ...SelectedDocket.shape,
      kind: SelectedDocket.shape.kind.optional(),
    }),

  errors: [
    {
      reason: 'document_not_on_page',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A selected document ID is absent from the requested entries page.',
      recovery:
        'List the docket entries on the intended entries_page, then select document IDs from that page.',
    },
    {
      reason: 'document_ownership_unverified',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The selected document entry has no explicit matching docket relation.',
      recovery:
        'Check the docket and entries page selection; retry only after the source entry explicitly belongs to this docket.',
    },
    {
      reason: 'selection_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A text retrieval cursor is supplied without document_ids.',
      recovery:
        'Repeat the original docket ID, entries_page and document_ids with the retrieval cursor.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A cursor is malformed, out of range or bound to another page or selection.',
      recovery:
        'Restart without cursor using the original docket ID, entries_page and document_ids.',
      thrownBy: 'service',
    },
    {
      reason: 'stale_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Selected source records changed since retrieval began.',
      recovery:
        'Restart without cursor using the original docket ID, entries_page and document_ids.',
      thrownBy: 'service',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Docket ID does not exist in CourtListener.',
      recovery:
        'Verify the docket ID from courtlistener_search_dockets. The docket may not be in RECAP coverage.',
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: '429 from CourtListener, or no request slot opened within the wait budget.',
      retryable: false,
      recovery:
        'Wait out the Retry-After interval reported on the error before calling again. CourtListener throttles per minute, hour, and day, so an immediate retry fails.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    if (input.cursor !== undefined && !input.document_ids) throw ctx.fail('selection_required');
    const selection = input.document_ids
      ? [...new Set(input.document_ids)].sort((a, b) => a - b)
      : undefined;
    const retrievalTool = `docket_documents:${input.entries_page}`;
    const cursor = readRetrievalCursor(
      input.cursor,
      retrievalTool,
      input.docket_id,
      selection?.map(String),
    );
    ctx.log.info('courtlistener_get_docket', {
      docket_id: input.docket_id,
      entries_page: input.entries_page,
      entries_page_size: input.entries_page_size,
    });
    const svc = getCourtListenerService();
    const fetchDocket = () =>
      svc.getDocket(
        input.docket_id,
        Math.min(input.entries_page_size, 50),
        input.entries_page,
        ctx,
      );

    if (selection) {
      const {
        value: { docketId, nextCursor, documents },
        fetchedAt,
      } = await readRetrievalSnapshot({
        service: svc,
        tenantId: ctx.tenantId,
        source: [
          'docket_documents',
          input.docket_id,
          input.entries_page,
          input.entries_page_size,
          selection,
        ],
        continuing: cursor !== undefined,
        signal: ctx.signal,
        fetch: async () => {
          const docket = await fetchDocket();
          const wanted = new Set(selection);
          const documents = (docket.docket_entries ?? []).flatMap((entry) => {
            const matches = (entry.recap_documents ?? []).filter((document) =>
              wanted.has(document.id),
            );
            if (matches.length > 0) {
              const owner =
                typeof entry.docket === 'number'
                  ? entry.docket
                  : typeof entry.docket === 'string'
                    ? idFromUri(entry.docket, 'dockets')
                    : null;
              if (owner !== input.docket_id)
                throw ctx.fail(
                  'document_ownership_unverified',
                  'The selected entry does not explicitly belong to the requested docket.',
                  { entry_id: entry.id },
                );
            }
            return matches.map((document) => ({ document, entryId: entry.id }));
          });
          const found = new Set(documents.map(({ document }) => document.id));
          const missing = selection.filter((id) => !found.has(id));
          if (missing.length)
            throw ctx.fail(
              'document_not_on_page',
              'Selected documents are not present on this entries page.',
              { document_ids: missing, entries_page: input.entries_page },
            );
          return {
            docketId: docket.id,
            nextCursor: docket.docket_entries_next_page ?? null,
            documents,
          };
        },
      });
      const selected = documents
        .map(({ document, entryId }) => ({
          id: document.id,
          entry_id: entryId,
          document_number:
            document.document_number == null ? null : String(document.document_number),
          attachment_number: document.attachment_number ?? null,
          description: document.description ?? '',
          is_available: document.is_available ?? null,
          page_count: document.page_count ?? null,
          filepath_local: toStorageUrl(document.filepath_local ?? null),
          source_url: document.absolute_url
            ? new URL(document.absolute_url, 'https://www.courtlistener.com').href
            : null,
          ...(document.plain_text !== undefined ? { plain_text: document.plain_text } : {}),
          text_status: document.plain_text
            ? ('available' as const)
            : document.is_available === false
              ? ('unavailable' as const)
              : document.is_available === true
                ? ('not_extracted' as const)
                : ('unknown' as const),
        }))
        .sort((a, b) => a.id - b.id);
      const page = retrieve({
        tool: retrievalTool,
        id: input.docket_id,
        selection: selection.map(String),
        cursor,
        view: {
          docket_id: docketId,
          entries_page: input.entries_page,
          next_cursor: nextCursor,
          document_ids: selection,
          selected_documents: selected,
        },
        groups: [{ name: 'selected_documents', value: selected }],
        required: ['docket_id', 'entries_page', 'next_cursor'],
        signal: ctx.signal,
        planningFinalize: (value) => {
          const parsed = SelectedDocket.parse(value);
          return { structuredContent: parsed, content: formatRetrievalPage(parsed, false) };
        },
        finalize: (value) => {
          const parsed = SelectedDocket.parse({
            ...(value as object),
            source_fetched_at: fetchedAt,
          });
          return { structuredContent: parsed, content: formatRetrievalPage(parsed) };
        },
      });
      return { ...page, source_fetched_at: fetchedAt };
    }

    const docket = await fetchDocket();
    const entries = (docket.docket_entries ?? []).map((e) => ({
      id: e.id,
      entry_number: e.entry_number ?? null,
      date_filed: e.date_filed ?? '',
      description: e.description ?? '',
      documents: (e.recap_documents ?? []).map((d) => ({
        id: d.id,
        // /docket-entries/ sends document_number as a string ("1"); normalize to a string
        // (preserving non-integer attachment forms like "70-1") rather than coercing to a number.
        document_number: d.document_number == null ? null : String(d.document_number),
        attachment_number: d.attachment_number ?? null,
        description: d.description ?? '',
        is_available: d.is_available ?? false,
        page_count: d.page_count ?? null,
        filepath_local: toStorageUrl(d.filepath_local ?? null),
      })),
    }));

    ctx.log.info('courtlistener_get_docket complete', {
      docket_id: input.docket_id,
      entries_returned: entries.length,
      entries_total: docket.docket_entries_count,
      entries_next_page: docket.docket_entries_next_page,
    });

    return {
      docket_id: docket.id,
      case_name: docket.case_name ?? '',
      case_name_full: docket.case_name_full ?? '',
      court: resolveCourtName(docket.court_id),
      court_id: docket.court_id ?? '',
      cluster_ids: (docket.clusters ?? []).flatMap((uri) => idFromUri(uri, 'clusters') ?? []),
      audio_ids: (docket.audio_files ?? []).flatMap((uri) => idFromUri(uri, 'audio') ?? []),
      date_argued: docket.date_argued || null,
      suit_nature: docket.nature_of_suit || null,
      appeal_from: docket.appeal_from_str || null,
      date_last_filing: docket.date_last_filing || null,
      date_filed: docket.date_filed ?? '',
      date_terminated: docket.date_terminated ?? null,
      docket_number: docket.docket_number ?? '',
      pacer_case_id: docket.pacer_case_id ?? null,
      assigned_to: docket.assigned_to_str ?? null,
      referred_to: docket.referred_to_str ?? null,
      cause: docket.cause ?? '',
      jury_demand: docket.jury_demand ?? '',
      jurisdiction_type: docket.jurisdiction_type ?? '',
      total_entries: docket.docket_entries_count ?? null,
      entries_page: input.entries_page,
      next_cursor: docket.docket_entries_next_page ?? null,
      entries,
      page_sizing: pageSizing(input.entries_page_size, 50, entries.length, 'fixed_20'),
    };
  },

  format: (result) => {
    if (result.kind) return formatRetrievalPage(result);
    const lines: string[] = [
      `## ${result.case_name}`,
      formatPageSizing(result.page_sizing),
      `**Docket ID:** ${result.docket_id} | **Court:** ${result.court} (${result.court_id})`,
      `**Docket #:** ${result.docket_number} | **Filed:** ${result.date_filed}${result.date_terminated ? ` | **Terminated:** ${result.date_terminated}` : ''}`,
    ];

    if (result.case_name_full && result.case_name_full !== result.case_name) {
      lines.push(`*${result.case_name_full}*`);
    }
    if (result.assigned_to) lines.push(`**Judge:** ${result.assigned_to}`);
    if (result.referred_to) lines.push(`**Referred to:** ${result.referred_to}`);
    if (result.cluster_ids)
      lines.push(`**Opinion cluster IDs:** ${result.cluster_ids.join(', ') || 'none'}`);
    if (result.audio_ids) lines.push(`**Audio IDs:** ${result.audio_ids.join(', ') || 'none'}`);
    if (result.date_argued !== undefined)
      lines.push(`**Argued:** ${result.date_argued ?? 'unknown'}`);
    if (result.suit_nature !== undefined)
      lines.push(`**Nature of suit:** ${result.suit_nature ?? 'unknown'}`);
    if (result.appeal_from !== undefined)
      lines.push(`**Appeal from:** ${result.appeal_from ?? 'unknown'}`);
    if (result.date_last_filing !== undefined)
      lines.push(`**Last filing:** ${result.date_last_filing ?? 'unknown'}`);
    if (result.cause) lines.push(`**Cause:** ${result.cause}`);
    if (result.jury_demand) lines.push(`**Jury demand:** ${result.jury_demand}`);
    if (result.jurisdiction_type) lines.push(`**Jurisdiction:** ${result.jurisdiction_type}`);
    if (result.pacer_case_id) lines.push(`**PACER ID:** ${result.pacer_case_id}`);
    lines.push(
      `**Total entries:** ${result.total_entries ?? 'unknown'} | **Page:** ${result.entries_page} | **Next cursor:** ${result.next_cursor ?? 'none'}`,
    );

    if (result.entries && result.entries.length > 0) {
      lines.push('\n### Docket Entries');
      for (const e of result.entries) {
        lines.push(
          `\n**Entry ID:** ${e.id} | **#${e.entry_number ?? 'N/A'}** (${e.date_filed}): ${e.description}`,
        );
        for (const d of e.documents) {
          const avail = d.is_available ? '[available]' : '[requires PACER]';
          const file = d.filepath_local ? ` ${markdownLink('RECAP file', d.filepath_local)}` : '';
          const pages = d.page_count != null ? `, ${d.page_count}pp` : '';
          const attach = d.attachment_number != null ? ` attachment #${d.attachment_number}` : '';
          lines.push(
            `  - Doc ID ${d.id} #${d.document_number ?? 'N/A'}${attach}: ${d.description}${pages} ${avail}${file}`,
          );
        }
      }
    }

    if (result.next_cursor) {
      lines.push(
        `\n*More entries available — pass entries_page=${result.next_cursor} to continue.*`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
