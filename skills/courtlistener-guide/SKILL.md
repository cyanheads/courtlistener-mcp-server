---
name: courtlistener-guide
description: Resolve identifiers and assess completeness when using courtlistener_* tools for US case-law research, precedent tracing, federal RECAP dockets, or judicial disclosures. Use before drawing conclusions from citation links, partial text, or missing records.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.1"
---

## Scope

Use CourtListener for US written opinions, citation links, federal RECAP dockets, judge records, oral arguments, and judicial disclosures. A CourtListener API token is required. RECAP is a partial federal PACER mirror; this server does not cover state-court dockets or purchase PACER documents.

## Identifiers

- Opinion search and citation lookup return cluster IDs: a decision grouping its opinion variants. Pass these to courtlistener_get_opinion and courtlistener_get_citations.
- Variant IDs and variant cites lists identify individual opinions, not clusters. Do not pass those IDs to tools requiring a cluster ID; use courtlistener_get_citations to follow the authority chain.
- Docket IDs come from docket search or linked opinion records. Use them for courtlistener_get_docket and courtlistener_get_parties. Document IDs, docket-entry IDs, PACER document numbers, and docket numbers are distinct identifiers.
- Judge search returns person IDs; opinion author IDs and oral-argument panel IDs also identify people. Use these for courtlistener_get_judge and judge-specific disclosure searches. Resolve a name before linking records to a person.
- Disclosure search returns disclosure IDs for courtlistener_get_financial_disclosure. Oral-argument search and docket audio_ids return audio IDs for courtlistener_get_oral_argument; docket cluster_ids lead to courtlistener_get_opinion.

## Gates

- Inspect each citation lookup result's resolution status. A successful call can contain unresolved citations or several candidate cases; resolve the intended case before following its cluster.
- Read the relevant opinion variant before attributing a holding or characterizing how a later decision treats a precedent. Citation edges establish links, not approval, rejection, or distinguishing treatment. Search snippets are cluster relevance previews and may come from a concurrence or dissent. Use outline variant labels to choose the text; an opening or empty excerpt from a filter-only search is not evidence that the text lacks a concept.
- Finish the text needed for the conclusion. An outline is a catalog, not the withheld text. Continue retrieval with the original identity, selection, and opinion text mode unchanged; reconstruct chunks using their paths and absolute ranges rather than appending repeated rows.
- Check source_fetched_at when recency matters. Continuations can reuse source for five minutes; start without a cursor to fetch fresh source. A stale_cursor requires a new retrieval and replacement of the old slices. Opinion docket enrichment is fetched independently and can be newer than the opinion snapshot.
- Keep opinion text and docket backfill retrieval separate. Follow retrieval.next_cursor for the primary opinion and enrichment_retrieval.next_cursor through enrichment_cursor for oversized backfill, with the same cluster and variant selection. Track enrichment ranges independently even when their paths name top-level fields. If enrichment source_id changes, discard prior enrichment slices and collect the replacement; do not discard primary opinion slices merely because backfill changed.
- Check source completion separately from retrieval completion. Exhausting retrieval only exhausts the fetched view: opinion variants, citation source variants, judge positions, or attorney resolution may still be incomplete. Report that limit with the finding.
- Do not stop at an empty page when a continuation remains. Disclosure-year filters and outbound-citation filters can leave an empty page before later matches.
- Choose publication coverage before tracing citations. Both directions default to Published opinions; select the statuses the research question requires. An outbound total counts distinct cited opinion IDs before filters, while an inbound total counts matching clusters, so the two totals measure different things.
- Do not equate missing RECAP records with a case or filing not existing. Check document availability before relying on a stored copy; do not infer missing content from metadata.
- Select filing text only from documents listed on the same docket entries page. A selection from another page or an entry without explicit matching docket ownership is rejected; list the intended page before retrying.
- Keep filing-text continuation separate from entries pagination. Finish retrieval with the same docket, entries page, and document selection before moving to another entries page. File availability does not establish extracted-text availability: inspect text_status, including unavailable, not_extracted, and unknown outcomes.
- Preserve disclosure dollar ranges as ranges. Check extraction status and retrieve relevant line items before drawing a conclusion from category counts.

## Core chain

Resolve a known citation with courtlistener_lookup_citation, or find candidates with courtlistener_search_opinions. Inspect the selected cluster with courtlistener_get_opinion, distinguish its lead, concurrence, and dissent variants, and retrieve the passages supporting the answer. Trace a targeted citation link with courtlistener_get_citations, then read the related cluster before describing treatment.

## Workflows

For federal litigation research, use courtlistener_search_dockets to identify the case, then courtlistener_get_docket to inspect its entries and documents. Search results carry only sample documents; their roster counts describe indexed names, not authoritative party or counsel totals. Select the relevant document IDs from the returned entries page and call courtlistener_get_docket again for their extracted text. Selection uses records embedded in that page without additional document requests; it does not search other pages or extract a missing text layer. Complete any text retrieval before following the entries continuation, and retain the document's source links with cited passages. Use entry dates to identify recent filings because entry order follows entry number. Use courtlistener_get_parties for docket-scoped representation rather than assuming a name match establishes counsel's role.

For judicial-background or disclosure research, resolve the person with courtlistener_search_judges, inspect courtlistener_get_judge, then use courtlistener_search_financial_disclosures and courtlistener_get_financial_disclosure for the relevant filings and categories. Follow remaining search pages when seeking a particular year. Keep missing, unextracted, and incomplete records distinct from evidence of no reported interest.

For argument context, find a recording with courtlistener_search_oral_arguments and inspect it with courtlistener_get_oral_argument. An absent transcript does not establish that no recording exists; use the returned recording metadata and source links.
