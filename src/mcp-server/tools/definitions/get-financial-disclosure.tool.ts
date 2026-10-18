/**
 * @fileoverview Fetch a single judicial financial disclosure with its parsed
 * line-item categories (investments, debts, positions, income, etc.).
 * @module mcp-server/tools/definitions/get-financial-disclosure.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatOutline, OUTLINE_VARIANT } from '@cyanheads/mcp-ts-core/utils';
import { getCourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import { presentation } from '@/services/courtlistener/readable-text.js';
import {
  formatRetrievalPage,
  Retrieval,
  RetrievalCursor,
  readRetrievalCursor,
  retrieve,
} from '@/services/courtlistener/retrieval.js';
import type {
  Agreement,
  Debt,
  DisclosurePosition,
  FinancialDisclosure,
  FinancialGift,
  Investment,
  NonInvestmentIncome,
  Reimbursement,
  SpouseIncome,
} from '@/services/courtlistener/types.js';
import { personIdFromUri } from '@/services/courtlistener/uri.js';

/** Selectable line-item categories, in a stable order. Also the outline section names. */
const CATEGORY_NAMES = [
  'investments',
  'debts',
  'positions',
  'reimbursements',
  'non_investment_incomes',
  'spouse_incomes',
  'agreements',
  'gifts',
] as const;
type CategoryName = (typeof CATEGORY_NAMES)[number];

/** Disclosure report-type codes from CourtListener (mirrors the search tool's legend). */
const REPORT_TYPE_LABELS: Record<number, string> = {
  [-1]: 'Unknown',
  0: 'Nomination',
  1: 'Initial',
  2: 'Annual',
  3: 'Final',
};

/**
 * AO Financial Disclosure Report form codes → readable dollar ranges. Codes are
 * standardized on the filing itself (the Filers' Instructions legend); they are
 * adapted from CourtListener's own disclosure model (open-ended top brackets lightly
 * humanized, e.g. 'Over $5,000,000') so the tool surfaces ranges rather than opaque
 * single letters. Empty codes decode to '' (no value
 * reported); an unrecognized code passes through unchanged (no data lost).
 */
const INCOME_GAIN_RANGES: Record<string, string> = {
  A: '$1 - $1,000',
  B: '$1,001 - $2,500',
  C: '$2,501 - $5,000',
  D: '$5,001 - $15,000',
  E: '$15,001 - $50,000',
  F: '$50,001 - $100,000',
  G: '$100,001 - $1,000,000',
  H1: '$1,000,001 - $5,000,000',
  H2: 'Over $5,000,000',
  '-1': 'Failed extraction',
};
const GROSS_VALUE_RANGES: Record<string, string> = {
  J: '$1 - $15,000',
  K: '$15,001 - $50,000',
  L: '$50,001 - $100,000',
  M: '$100,001 - $250,000',
  N: '$250,001 - $500,000',
  O: '$500,001 - $1,000,000',
  P1: '$1,000,001 - $5,000,000',
  P2: '$5,000,001 - $25,000,000',
  P3: '$25,000,001 - $50,000,000',
  P4: 'Over $50,000,000',
  '-1': 'Failed extraction',
};
const VALUATION_METHODS: Record<string, string> = {
  Q: 'Appraisal',
  R: 'Cost (real estate only)',
  S: 'Assessment',
  T: 'Cash/market value',
  U: 'Book value',
  V: 'Other',
  W: 'Estimated',
  '-1': 'Failed extraction',
};

/** Decode an AO form code to its label; '' stays '', an unknown code stays raw. */
function decode(code: string, table: Record<string, string>): string {
  return Object.hasOwn(table, code) ? (table[code] as string) : code;
}

// ── Per-category normalizers: raw upstream row → readable output row ─────────────

function normalizeInvestment(inv: Investment) {
  return {
    id: inv.id,
    description: inv.description ?? '',
    income_type: inv.income_during_reporting_period_type ?? '',
    income_range: decode(inv.income_during_reporting_period_code ?? '', INCOME_GAIN_RANGES),
    value_range: decode(inv.gross_value_code ?? '', GROSS_VALUE_RANGES),
    value_method: decode(inv.gross_value_method ?? '', VALUATION_METHODS),
    transaction: inv.transaction_during_reporting_period ?? '',
    transaction_date: inv.transaction_date_raw ?? '',
    transaction_value_range: decode(inv.transaction_value_code ?? '', GROSS_VALUE_RANGES),
    transaction_gain_range: decode(inv.transaction_gain_code ?? '', INCOME_GAIN_RANGES),
    transaction_partner: inv.transaction_partner ?? '',
    redacted: inv.redacted ?? false,
  };
}

function normalizeDebt(debt: Debt) {
  return {
    id: debt.id,
    creditor: debt.creditor_name ?? '',
    description: debt.description ?? '',
    value_range: decode(debt.value_code ?? '', GROSS_VALUE_RANGES),
    redacted: debt.redacted ?? false,
  };
}

function normalizePosition(pos: DisclosurePosition) {
  return {
    id: pos.id,
    position: pos.position ?? '',
    organization: pos.organization_name ?? '',
    redacted: pos.redacted ?? false,
  };
}

function normalizeReimbursement(r: Reimbursement) {
  return {
    id: r.id,
    source: r.source ?? '',
    date: r.date_raw ?? '',
    location: r.location ?? '',
    purpose: r.purpose ?? '',
    items: r.items_paid_or_provided ?? '',
    redacted: r.redacted ?? false,
  };
}

function normalizeNonInvestmentIncome(n: NonInvestmentIncome) {
  return {
    id: n.id,
    date: n.date_raw ?? '',
    source_type: n.source_type ?? '',
    amount: n.income_amount ?? '',
    redacted: n.redacted ?? false,
  };
}

function normalizeSpouseIncome(s: SpouseIncome) {
  return {
    id: s.id,
    source_type: s.source_type ?? '',
    date: s.date_raw ?? '',
    redacted: s.redacted ?? false,
  };
}

function normalizeAgreement(a: Agreement) {
  return {
    id: a.id,
    date: a.date_raw ?? '',
    parties_and_terms: a.parties_and_terms ?? '',
    redacted: a.redacted ?? false,
  };
}

function normalizeGift(g: FinancialGift) {
  return {
    description: g.description ?? '',
    source: g.source ?? '',
    value: g.value ?? '',
  };
}

// ── Output row schemas ──────────────────────────────────────────────────────────

const InvestmentRow = z
  .object({
    id: z.number().describe('Investment row ID.'),
    description: z.string().describe('Name of the holding (e.g. "Citibank, N.A. Accounts").'),
    income_type: z
      .string()
      .describe('Income type (e.g. "Interest", "Dividend", "Rent"); empty if none.'),
    income_range: z
      .string()
      .describe(
        'Income during the reporting period as a dollar range (e.g. "$1 - $1,000"); empty if none.',
      ),
    value_range: z
      .string()
      .describe(
        'Gross value at period end as a dollar range (e.g. "$250,001 - $500,000"); empty if none.',
      ),
    value_method: z
      .string()
      .describe('Valuation method (e.g. "Cash/market value", "Appraisal"); empty if none.'),
    transaction: z
      .string()
      .describe('Transaction during the period (e.g. "Buy", "Sold"); empty if none.'),
    transaction_date: z.string().describe('Transaction date as filed; empty if none.'),
    transaction_value_range: z
      .string()
      .describe('Transaction value as a dollar range; empty if none.'),
    transaction_gain_range: z
      .string()
      .describe('Gain realized on the transaction as a dollar range; empty if none.'),
    transaction_partner: z.string().describe('Identity of the transaction partner; empty if none.'),
    redacted: z.boolean().describe('True if the source row was partially redacted.'),
  })
  .partial({
    description: true,
    income_type: true,
    income_range: true,
    value_range: true,
    value_method: true,
    transaction: true,
    transaction_date: true,
    transaction_value_range: true,
    transaction_gain_range: true,
    transaction_partner: true,
  })
  .describe(
    'An investment holding (Part VII); omitted partial strings remain reachable through retrieval.',
  );

const DebtRow = z
  .object({
    id: z.number().describe('Debt row ID.'),
    creditor: z.string().describe('Creditor name (e.g. "Wells Fargo Bank, NA").'),
    description: z.string().describe('Description of the liability.'),
    value_range: z.string().describe('Value of the debt as a dollar range; empty if none.'),
    redacted: z.boolean().describe('True if the source row was partially redacted.'),
  })
  .partial({ creditor: true, description: true, value_range: true })
  .describe(
    'A debt or liability (Part VII); omitted partial strings remain reachable through retrieval.',
  );

const PositionRow = z
  .object({
    id: z.number().describe('Position row ID.'),
    position: z.string().describe('Position title (e.g. "Governing Director").'),
    organization: z.string().describe('Organization or entity name.'),
    redacted: z.boolean().describe('True if the source row was partially redacted.'),
  })
  .partial({ position: true, organization: true })
  .describe(
    'An outside position held by the filer (Part I); omitted partial strings remain reachable through retrieval.',
  );

const ReimbursementRow = z
  .object({
    id: z.number().describe('Reimbursement row ID.'),
    source: z.string().describe('Who provided the reimbursement (e.g. a law school).'),
    date: z.string().describe('Dates as filed (e.g. "April 3-5, 2022").'),
    location: z.string().describe('Location of the reimbursed event.'),
    purpose: z.string().describe('Purpose of the reimbursement.'),
    items: z.string().describe('Items reimbursed (e.g. "Transportation, Lodging and Meals").'),
    redacted: z.boolean().describe('True if the source row was partially redacted.'),
  })
  .partial({ source: true, date: true, location: true, purpose: true, items: true })
  .describe(
    'A travel/event reimbursement (Part IV); omitted partial strings remain reachable through retrieval.',
  );

const NonInvestmentIncomeRow = z
  .object({
    id: z.number().describe('Non-investment income row ID.'),
    date: z.string().describe('Date as filed (e.g. "3/10/2022").'),
    source_type: z.string().describe('Source and type of the income.'),
    amount: z.string().describe('Amount as filed — usually a dollar string (e.g. "$10,116.00").'),
    redacted: z.boolean().describe('True if the source row was partially redacted.'),
  })
  .partial({ date: true, source_type: true, amount: true })
  .describe(
    "The filer's non-investment income (Part II); omitted partial strings remain reachable through retrieval.",
  );

const SpouseIncomeRow = z
  .object({
    id: z.number().describe('Spouse income row ID.'),
    source_type: z.string().describe('Source and type of the spousal income.'),
    date: z.string().describe('Date as filed.'),
    redacted: z.boolean().describe('True if the source row was partially redacted.'),
  })
  .partial({ source_type: true, date: true })
  .describe(
    "The filer's spouse income (Part III); omitted partial strings remain reachable through retrieval.",
  );

const AgreementRow = z
  .object({
    id: z.number().describe('Agreement row ID.'),
    date: z.string().describe('Date of the agreement as filed.'),
    parties_and_terms: z.string().describe('Parties to and terms of the agreement.'),
    redacted: z.boolean().describe('True if the source row was partially redacted.'),
  })
  .partial({ date: true, parties_and_terms: true })
  .describe(
    'A continuing agreement or arrangement (Part VIII); omitted partial strings remain reachable through retrieval.',
  );

const GiftRow = z
  .object({
    description: z.string().describe('What the gift was.'),
    source: z.string().describe('Who provided the gift.'),
    value: z.string().describe('Reported dollar value; empty if not stated.'),
  })
  .partial({ description: true, source: true, value: true })
  .describe(
    'A reported gift (Part VI); omitted partial strings remain reachable through retrieval.',
  );

const CountsShape = z
  .object({
    investments: z.number().describe('Number of reported investments.'),
    gifts: z.number().describe('Number of reported gifts.'),
    debts: z.number().describe('Number of reported debts/liabilities.'),
    positions: z.number().describe('Number of reported outside positions.'),
    reimbursements: z.number().describe('Number of reported reimbursements.'),
    agreements: z.number().describe('Number of reported agreements.'),
    non_investment_incomes: z
      .number()
      .describe('Number of reported non-investment income sources.'),
    spouse_incomes: z.number().describe('Number of reported spouse income sources.'),
  })
  .describe('Count of line items in each disclosure category.');

export const getFinancialDisclosureTool = tool('courtlistener_get_financial_disclosure', {
  title: 'Get Financial Disclosure',
  description:
    'Fetch a judicial financial disclosure by disclosure_id from courtlistener_search_financial_disclosures. Returns metadata, counts and typed line items with coded values decoded to dollar ranges. Select categories or omit for all. Oversized selections return outline then page responses; continue retrieval.next_cursor as cursor with the unchanged ID/categories selection until null. Large individual row fields remain recoverable through text_chunks.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    cursor: RetrievalCursor,
    disclosure_id: z
      .number()
      .int()
      .describe(
        'Financial disclosure ID — the disclosure_id field from a courtlistener_search_financial_disclosures result.',
      ),
    categories: z
      .array(z.enum(CATEGORY_NAMES))
      .optional()
      .describe(
        'Line-item categories to select. Omit for all. Oversized selections page; keep this selection unchanged while following cursor.',
      ),
  }),

  output: z
    .object({
      retrieval: Retrieval,
      // Bounded identity stays present; oversized metadata follows retrieval paths.
      disclosure_id: z.number().describe('Financial disclosure ID.'),
      person_id: z
        .number()
        .nullable()
        .describe('Person ID of the filer — pass to courtlistener_get_judge; null if absent.'),
      year: z.number().describe('Filing year.'),
      report_type: z
        .string()
        .describe('Report type (Nomination, Initial, Annual, Final, or Unknown).'),
      page_count: z
        .number()
        .nullable()
        .describe('Page count of the source filing; null if not recorded.'),
      has_been_extracted: z
        .boolean()
        .describe(
          'True if line items were parsed from the PDF; category arrays are empty when false.',
        ),
      is_amended: z.boolean().describe('True if this filing is an amendment.'),
      pdf_url: z
        .string()
        .nullable()
        .describe('URL to the source disclosure PDF; null if unavailable.'),
      counts: CountsShape,
      kind: z
        .enum(['full', 'outline', 'page'])
        .describe(
          "'full' carries a small selected record; 'outline' pages the section catalog; 'page' carries typed rows and field-path text chunks. Filing identity and counts remain present.",
        ),
      // Full arm — one field per category, present when selected and non-empty. Omitted in outline mode.
      investments: z.array(InvestmentRow).optional().describe('Investment holdings.'),
      debts: z.array(DebtRow).optional().describe('Debts and liabilities.'),
      positions: z.array(PositionRow).optional().describe('Outside positions.'),
      reimbursements: z.array(ReimbursementRow).optional().describe('Reimbursements.'),
      non_investment_incomes: z
        .array(NonInvestmentIncomeRow)
        .optional()
        .describe('Non-investment income sources.'),
      spouse_incomes: z.array(SpouseIncomeRow).optional().describe('Spouse income sources.'),
      agreements: z.array(AgreementRow).optional().describe('Continuing agreements.'),
      gifts: z.array(GiftRow).optional().describe('Reported gifts.'),
      // Outline arm — one section per category. Reuses OUTLINE_VARIANT's shape; the section
      // element gets an object-level describe (the framework schema describes only name/bytes),
      // and the re-call notice is named retrieval_notice so it reads as domain data (a field
      // literally named `notice` reads as agent-facing context).
      sections: z
        .array(
          OUTLINE_VARIANT.shape.sections.element.describe(
            'A retrievable category (by name) and its serialized byte size.',
          ),
        )
        .optional()
        .describe(
          'Category catalog in declared order, with paged metadata fields. Follow retrieval.next_cursor to finish the catalog and retrieve data.',
        ),
      retrieval_notice: OUTLINE_VARIANT.shape.notice
        .optional()
        .describe('How to continue bounded retrieval using the unchanged ID and selection.'),
    })
    .partial({ report_type: true, pdf_url: true }),

  errors: [
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Retrieval cursor is malformed, out of range or belongs to another request.',
      recovery: 'Restart without cursor using the original ID and selection.',
      thrownBy: 'service',
    },
    {
      reason: 'stale_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The normalized selected source changed since the previous page.',
      recovery: 'Restart without cursor to retrieve the current source consistently.',
      thrownBy: 'service',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Disclosure ID does not exist in CourtListener.',
      recovery: 'Verify the disclosure ID from courtlistener_search_financial_disclosures.',
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
    const cursor = readRetrievalCursor(
      input.cursor,
      'disclosure',
      input.disclosure_id,
      input.categories,
    );
    ctx.log.info('courtlistener_get_financial_disclosure', {
      disclosure_id: input.disclosure_id,
      categories: input.categories,
    });
    const svc = getCourtListenerService();
    const d: FinancialDisclosure = await svc.getFinancialDisclosure(input.disclosure_id, ctx);

    const counts = {
      investments: d.investments.length,
      gifts: d.gifts.length,
      debts: d.debts.length,
      positions: d.positions.length,
      reimbursements: d.reimbursements.length,
      agreements: d.agreements.length,
      non_investment_incomes: d.non_investment_incomes.length,
      spouse_incomes: d.spouse_incomes.length,
    };

    // Normalize metadata before measuring the selected view.
    const meta = {
      disclosure_id: d.id,
      person_id: personIdFromUri(d.person ?? ''),
      year: d.year ?? 0,
      report_type: REPORT_TYPE_LABELS[d.report_type] ?? `Type ${d.report_type}`,
      page_count: d.page_count ?? null,
      has_been_extracted: d.has_been_extracted ?? false,
      is_amended: d.is_amended ?? false,
      pdf_url: d.filepath ?? null,
      counts,
    };

    // Normalize every category once (typed), then pick the requested, non-empty ones.
    const normalized = {
      investments: d.investments.map(normalizeInvestment),
      debts: d.debts.map(normalizeDebt),
      positions: d.positions.map(normalizePosition),
      reimbursements: d.reimbursements.map(normalizeReimbursement),
      non_investment_incomes: d.non_investment_incomes.map(normalizeNonInvestmentIncome),
      spouse_incomes: d.spouse_incomes.map(normalizeSpouseIncome),
      agreements: d.agreements.map(normalizeAgreement),
      gifts: d.gifts.map(normalizeGift),
    };

    const want = (c: CategoryName) => !input.categories?.length || input.categories.includes(c);
    // Explicit per-category assignment keeps each field's element type intact (a
    // keyed loop would erase it to a heterogeneous union). Empty categories are
    // dropped — an empty array has nothing to retrieve and its size shows in `counts`.
    const arrays: Partial<typeof normalized> = {};
    if (want('investments') && normalized.investments.length)
      arrays.investments = normalized.investments;
    if (want('debts') && normalized.debts.length) arrays.debts = normalized.debts;
    if (want('positions') && normalized.positions.length) arrays.positions = normalized.positions;
    if (want('reimbursements') && normalized.reimbursements.length)
      arrays.reimbursements = normalized.reimbursements;
    if (want('non_investment_incomes') && normalized.non_investment_incomes.length)
      arrays.non_investment_incomes = normalized.non_investment_incomes;
    if (want('spouse_incomes') && normalized.spouse_incomes.length)
      arrays.spouse_incomes = normalized.spouse_incomes;
    if (want('agreements') && normalized.agreements.length)
      arrays.agreements = normalized.agreements;
    if (want('gifts') && normalized.gifts.length) arrays.gifts = normalized.gifts;

    ctx.log.info('courtlistener_get_financial_disclosure complete', {
      disclosure_id: d.id,
      returned_categories: Object.keys(arrays),
    });

    return retrieve({
      tool: 'disclosure',
      id: input.disclosure_id,
      selection: input.categories,
      cursor,
      view: { ...meta, ...arrays },
      groups: Object.entries(arrays).map(([name, value]) => ({ name, value })),
      required: [
        'disclosure_id',
        'person_id',
        'year',
        'page_count',
        'has_been_extracted',
        'is_amended',
        'counts',
      ],
      signal: ctx.signal,
      finalize: finalizeDisclosure,
    });
  },

  format: (result) => {
    if (result.retrieval) return formatRetrievalPage(result);
    result = presentation(result);
    // Cheap filing metadata — always present, so this header renders in every mode.
    const lines: string[] = [
      `## ${result.report_type} financial disclosure — ${result.year}`,
      `**Disclosure ID:** ${result.disclosure_id} | **Person ID:** ${result.person_id ?? 'Unknown'} | **Pages:** ${result.page_count ?? 'N/A'}`,
      `**Extracted:** ${result.has_been_extracted ? 'yes' : 'no'} | **Amended:** ${result.is_amended ? 'yes' : 'no'}`,
      result.kind === 'outline'
        ? '**Response:** category outline — continue retrieval.next_cursor with the unchanged ID and categories'
        : '**Response:** full itemization',
    ];
    const c = result.counts;
    lines.push(
      `**Counts:** ${c.investments} investments, ${c.gifts} gifts, ${c.debts} debts, ${c.positions} positions, ${c.reimbursements} reimbursements, ${c.agreements} agreements, ${c.non_investment_incomes} non-investment incomes, ${c.spouse_incomes} spouse incomes`,
    );
    if (result.pdf_url) lines.push(`**Source PDF:** ${result.pdf_url}`);

    // Full arm — one block per requested category. Each field is interpolated
    // unconditionally so both client surfaces carry the complete row.
    for (const inv of result.investments ?? []) {
      lines.push(`\n### Investment #${inv.id}${inv.redacted ? ' (redacted)' : ''}`);
      lines.push(`**${inv.description}**`);
      lines.push(`- Income: ${inv.income_type} ${inv.income_range}`.trimEnd());
      lines.push(`- Value: ${inv.value_range} (${inv.value_method})`);
      lines.push(
        `- Transaction: ${inv.transaction} ${inv.transaction_date} — value ${inv.transaction_value_range}, gain ${inv.transaction_gain_range}, partner ${inv.transaction_partner}`,
      );
    }
    for (const debt of result.debts ?? []) {
      lines.push(`\n### Debt #${debt.id}${debt.redacted ? ' (redacted)' : ''}`);
      lines.push(`**${debt.creditor}** — ${debt.description} (value ${debt.value_range})`);
    }
    for (const pos of result.positions ?? []) {
      lines.push(`\n### Position #${pos.id}${pos.redacted ? ' (redacted)' : ''}`);
      lines.push(`**${pos.position}** — ${pos.organization}`);
    }
    for (const r of result.reimbursements ?? []) {
      lines.push(`\n### Reimbursement #${r.id}${r.redacted ? ' (redacted)' : ''}`);
      lines.push(`**${r.source}** (${r.date}, ${r.location})`);
      lines.push(`- Purpose: ${r.purpose}`);
      lines.push(`- Items: ${r.items}`);
    }
    for (const n of result.non_investment_incomes ?? []) {
      lines.push(`\n### Non-investment income #${n.id}${n.redacted ? ' (redacted)' : ''}`);
      lines.push(`**${n.source_type}** — ${n.amount} (${n.date})`);
    }
    for (const s of result.spouse_incomes ?? []) {
      lines.push(`\n### Spouse income #${s.id}${s.redacted ? ' (redacted)' : ''}`);
      lines.push(`**${s.source_type}** (${s.date})`);
    }
    for (const a of result.agreements ?? []) {
      lines.push(`\n### Agreement #${a.id}${a.redacted ? ' (redacted)' : ''}`);
      lines.push(`${a.parties_and_terms} (${a.date})`);
    }
    for (const g of result.gifts ?? []) {
      lines.push(`\n### Gift`);
      lines.push(`${g.description} (from ${g.source}) — ${g.value}`);
    }

    // Outline arm — rendered whenever `sections` is present (independent of `kind`).
    const outlineBlocks = result.sections
      ? formatOutline({
          kind: 'outline',
          sections: result.sections,
          notice: result.retrieval_notice ?? '',
        })
      : [];

    return [{ type: 'text', text: lines.join('\n') }, ...outlineBlocks];
  },
});

/** No enrichment or collected media is declared here: parse + format is the complete success wire. */
function finalizeDisclosure(value: unknown): { structuredContent: object; content: unknown[] } {
  const parsed = getFinancialDisclosureTool.output.parse(value);
  const format = getFinancialDisclosureTool.format;
  if (!format) throw new Error('Bounded retrieval requires the production formatter.');
  return { structuredContent: parsed, content: format(parsed) };
}
