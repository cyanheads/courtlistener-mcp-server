/**
 * @fileoverview Tests for the get-financial-disclosure tool — code decoding,
 * category selection, outline-on-overflow, and format parity.
 * @module tests/tools/get-financial-disclosure.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFinancialDisclosureTool } from '@/mcp-server/tools/definitions/get-financial-disclosure.tool.js';
import type { CourtListenerService } from '@/services/courtlistener/courtlistener-service.js';
import * as svcModule from '@/services/courtlistener/courtlistener-service.js';
import type { FinancialDisclosure } from '@/services/courtlistener/types.js';

const mockSvc = {
  getFinancialDisclosure: vi.fn(),
} as unknown as CourtListenerService;

beforeEach(() => {
  vi.spyOn(svcModule, 'getCourtListenerService').mockReturnValue(mockSvc);
  vi.clearAllMocks();
});

// Values recorded from the live 2022 disclosure 34207 (person 3045). Coded columns
// carry real AO form codes so the decode assertions test the actual legend.
const baseDisclosure: FinancialDisclosure = {
  id: 34207,
  person: 'https://www.courtlistener.com/api/rest/v4/people/3045/',
  year: 2022,
  report_type: 2,
  page_count: 12,
  has_been_extracted: true,
  is_amended: false,
  filepath: 'https://storage.courtlistener.com/disclosures/2022/3045.pdf',
  investments: [
    {
      id: 5385757,
      description: 'Citibank, N.A. Accounts',
      income_during_reporting_period_code: 'A',
      income_during_reporting_period_type: 'Interest',
      gross_value_code: 'N',
      gross_value_method: 'T',
      transaction_during_reporting_period: '',
      transaction_date_raw: '',
      transaction_value_code: '',
      transaction_gain_code: '',
      transaction_partner: '',
      redacted: false,
    },
  ],
  debts: [
    {
      id: 53678,
      creditor_name: 'Wells Fargo Bank, NA',
      description: 'Mortgage on Rental Property #1',
      value_code: 'N',
      redacted: false,
    },
  ],
  positions: [
    { id: 99105, position: 'Governing Director', organization_name: 'iCivics', redacted: false },
  ],
  reimbursements: [
    {
      id: 97031,
      source: 'Washington University in St. Louis',
      date_raw: 'April 3-5, 2022',
      location: 'St Louis, MO',
      purpose: 'Meeting with students',
      items_paid_or_provided: 'Transportation, Lodging and Meals',
      redacted: false,
    },
  ],
  non_investment_incomes: [
    {
      id: 42529,
      date_raw: '3/10/2022',
      source_type: 'DHX Media Ltd. (second option fee)',
      income_amount: '$10,116.00',
      redacted: false,
    },
  ],
  spouse_incomes: [],
  agreements: [
    {
      id: 25179,
      date_raw: '2022',
      parties_and_terms: 'Adjunct Professor, Notre Dame Law School.',
      redacted: true,
    },
  ],
  gifts: [],
};

/** A filing whose itemization exceeds the inline budget across ≥2 categories. */
function makeOverflowDisclosure(): FinancialDisclosure {
  const longDesc = 'Common stock and mutual fund holding, account statement description. '.repeat(
    6,
  );
  return {
    ...baseDisclosure,
    investments: Array.from({ length: 100 }, (_, i) => ({
      id: 6000000 + i,
      description: `${longDesc} #${i}`,
      income_during_reporting_period_code: 'B',
      income_during_reporting_period_type: 'Dividend',
      gross_value_code: 'M',
      gross_value_method: 'T',
      transaction_during_reporting_period: '',
      transaction_date_raw: '',
      transaction_value_code: '',
      transaction_gain_code: '',
      transaction_partner: '',
      redacted: false,
    })),
    debts: [
      {
        id: 53678,
        creditor_name: 'Wells Fargo Bank, NA',
        description: 'Mortgage on Rental Property #1',
        value_code: 'N',
        redacted: false,
      },
    ],
  };
}

describe('getFinancialDisclosureTool', () => {
  it('returns full itemization with decoded codes for a small filing', async () => {
    mockSvc.getFinancialDisclosure = vi.fn().mockResolvedValue(baseDisclosure);
    const ctx = createMockContext({ errors: getFinancialDisclosureTool.errors });
    const input = getFinancialDisclosureTool.input.parse({ disclosure_id: 34207 });
    const result = await getFinancialDisclosureTool.handler(input, ctx);

    expect(result.kind).toBe('full');
    // filing metadata
    expect(result.disclosure_id).toBe(34207);
    expect(result.person_id).toBe(3045); // extracted from the person URI
    expect(result.year).toBe(2022);
    expect(result.report_type).toBe('Annual');
    expect(result.pdf_url).toContain('.pdf');
    // counts cover every category (present in every response)
    expect(result.counts.investments).toBe(1);
    expect(result.counts.spouse_incomes).toBe(0);

    // AO codes decode to readable dollar ranges / methods
    const inv = result.investments?.[0];
    expect(inv?.description).toBe('Citibank, N.A. Accounts');
    expect(inv?.income_type).toBe('Interest');
    expect(inv?.income_range).toBe('$1 - $1,000'); // code A
    expect(inv?.value_range).toBe('$250,001 - $500,000'); // code N
    expect(inv?.value_method).toBe('Cash/market value'); // code T
    // empty coded transaction columns decode to ''
    expect(inv?.transaction_value_range).toBe('');
    expect(inv?.transaction_gain_range).toBe('');

    expect(result.debts?.[0]?.value_range).toBe('$250,001 - $500,000'); // code N
    expect(result.positions?.[0]?.organization).toBe('iCivics');
    expect(result.non_investment_incomes?.[0]?.amount).toBe('$10,116.00');
    expect(result.agreements?.[0]?.redacted).toBe(true);

    // empty categories are omitted (their emptiness shows in counts)
    expect(result.spouse_incomes).toBeUndefined();
    expect(result.gifts).toBeUndefined();

    expect(() => getFinancialDisclosureTool.output.parse(result)).not.toThrow();
  });

  it('returns only the requested categories when categories is passed', async () => {
    mockSvc.getFinancialDisclosure = vi.fn().mockResolvedValue(baseDisclosure);
    const ctx = createMockContext({ errors: getFinancialDisclosureTool.errors });
    const input = getFinancialDisclosureTool.input.parse({
      disclosure_id: 34207,
      categories: ['investments', 'debts'],
    });
    const result = await getFinancialDisclosureTool.handler(input, ctx);

    expect(result.kind).toBe('full');
    expect(result.investments).toHaveLength(1);
    expect(result.debts).toHaveLength(1);
    // unrequested categories are absent, but counts still report their sizes
    expect(result.positions).toBeUndefined();
    expect(result.non_investment_incomes).toBeUndefined();
    expect(result.counts.positions).toBe(1);
    expect(() => getFinancialDisclosureTool.output.parse(result)).not.toThrow();
  });

  it('overflows to a per-category outline while keeping metadata and counts', async () => {
    mockSvc.getFinancialDisclosure = vi.fn().mockResolvedValue(makeOverflowDisclosure());
    const ctx = createMockContext({ errors: getFinancialDisclosureTool.errors });
    const input = getFinancialDisclosureTool.input.parse({ disclosure_id: 34207 });
    const result = await getFinancialDisclosureTool.handler(input, ctx);

    expect(result.kind).toBe('outline');
    // category arrays omitted in outline mode
    expect(result.investments).toBeUndefined();
    expect(result.debts).toBeUndefined();
    // one section per non-empty category, largest first
    const names = (result.sections ?? []).map((s) => s.name);
    expect(names).toContain('investments');
    expect(names).toContain('debts');
    expect(names[0]).toBe('investments'); // biggest category leads
    expect(result.retrieval_notice).toContain('categories:[');
    // cheap metadata + counts survive overflow
    expect(result.disclosure_id).toBe(34207);
    expect(result.counts.investments).toBe(100);
    expect(() => getFinancialDisclosureTool.output.parse(result)).not.toThrow();
  });

  it('returns a large category in full on an explicit category re-call (no overflow gate)', async () => {
    mockSvc.getFinancialDisclosure = vi.fn().mockResolvedValue(makeOverflowDisclosure());
    const ctx = createMockContext({ errors: getFinancialDisclosureTool.errors });
    const input = getFinancialDisclosureTool.input.parse({
      disclosure_id: 34207,
      categories: ['investments'],
    });
    const result = await getFinancialDisclosureTool.handler(input, ctx);

    // explicit selection returns the rows in full even when they exceed the inline budget
    expect(result.kind).toBe('full');
    expect(result.investments).toHaveLength(100);
    expect(result.sections).toBeUndefined();
    expect(result.debts).toBeUndefined();
    expect(() => getFinancialDisclosureTool.output.parse(result)).not.toThrow();
  });

  it('throws not_found for a missing disclosure', async () => {
    const { McpError, JsonRpcErrorCode } = await import('@cyanheads/mcp-ts-core/errors');
    mockSvc.getFinancialDisclosure = vi
      .fn()
      .mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'not found'));
    const ctx = createMockContext({ errors: getFinancialDisclosureTool.errors });
    const input = getFinancialDisclosureTool.input.parse({ disclosure_id: 99999 });
    await expect(getFinancialDisclosureTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('format renders filing metadata, counts, and decoded row data', () => {
    const output = getFinancialDisclosureTool.output.parse({
      kind: 'full',
      disclosure_id: 34207,
      person_id: 3045,
      year: 2022,
      report_type: 'Annual',
      page_count: 12,
      has_been_extracted: true,
      is_amended: false,
      pdf_url: 'https://storage.courtlistener.com/disclosures/2022/3045.pdf',
      counts: {
        investments: 1,
        gifts: 0,
        debts: 1,
        positions: 0,
        reimbursements: 0,
        agreements: 0,
        non_investment_incomes: 0,
        spouse_incomes: 0,
      },
      investments: [
        {
          id: 5385757,
          description: 'Citibank, N.A. Accounts',
          income_type: 'Interest',
          income_range: '$1 - $1,000',
          value_range: '$250,001 - $500,000',
          value_method: 'Cash/market value',
          transaction: '',
          transaction_date: '',
          transaction_value_range: '',
          transaction_gain_range: '',
          transaction_partner: '',
          redacted: false,
        },
      ],
      debts: [
        {
          id: 53678,
          creditor: 'Wells Fargo Bank, NA',
          description: 'Mortgage on Rental Property #1',
          value_range: '$250,001 - $500,000',
          redacted: false,
        },
      ],
    });
    const blocks = getFinancialDisclosureTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Annual');
    expect(text).toContain('34207');
    expect(text).toContain('3045');
    expect(text).toContain('1 investments');
    // decoded row data appears on the content[] surface
    expect(text).toContain('Citibank, N.A. Accounts');
    expect(text).toContain('$250,001 - $500,000');
    expect(text).toContain('Cash/market value');
    expect(text).toContain('Wells Fargo Bank, NA');
  });

  it('format renders the outline arm with metadata and category sections', () => {
    const output = getFinancialDisclosureTool.output.parse({
      kind: 'outline',
      disclosure_id: 34207,
      person_id: 3045,
      year: 2022,
      report_type: 'Annual',
      page_count: 12,
      has_been_extracted: true,
      is_amended: false,
      pdf_url: 'https://storage.courtlistener.com/disclosures/2022/3045.pdf',
      counts: {
        investments: 100,
        gifts: 0,
        debts: 2,
        positions: 0,
        reimbursements: 0,
        agreements: 0,
        non_investment_incomes: 0,
        spouse_incomes: 0,
      },
      sections: [
        { name: 'investments', bytes: 45000 },
        { name: 'debts', bytes: 300 },
      ],
      retrieval_notice:
        'Full itemization too large to inline. Re-call with categories:["investments"] to retrieve it.',
    });
    const blocks = getFinancialDisclosureTool.format!(output);
    const text = blocks.map((b) => (b as { text: string }).text).join('\n');
    // metadata rendered even in outline mode
    expect(text).toContain('Annual');
    expect(text).toContain('100 investments');
    // outline section list + notice rendered
    expect(text).toContain('investments');
    expect(text).toContain('categories:');
  });
});
