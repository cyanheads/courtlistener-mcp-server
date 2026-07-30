# courtlistener-mcp-server

CourtListener / RECAP — 9M+ full-text court opinions, oral arguments, and PACER docket data from Free Law Project.

## API

- **Base**: `https://www.courtlistener.com/api/rest/v4/`
- **Auth**: API token (free account)
- **Rate limits**: CourtListener publishes free-tier limits of 5 requests/min, 50/hr, 125/day; actual limits vary by token tier, so honor the Retry-After returned on a 429 rather than the published figure. Membership ($10+/mo) unlocks higher limits.
- **Docs**: https://www.courtlistener.com/help/api/rest/

## Key data

- **Opinions**: 9M+ full-text written court opinions (federal + state courts) — NOT audio-only as previously mischaracterized
- **Oral arguments**: Audio recordings from appellate courts (secondary to the text corpus)
- **RECAP/dockets**: Federal court docket entries and documents sourced from PACER
- **Courts**: Metadata on 400+ courts
- **Judges**: Biographical data, appointment history, education
- **Citations**: Opinion-to-opinion citation network

## Cross-domain value

| Chain to | Query |
|---|---|
| Congress | Legislation → court challenges and rulings |
| SEC EDGAR | Company named in rulings → financial disclosures about litigation risk |
| NIST NVD | CVE → court cases involving the vulnerability or affected products |
| OpenStates | State law → state court interpretation |
| Wikidata / Wikipedia | Judge backgrounds, landmark case context |
| OpenFEC | Judges appointed by which president → that president's campaign donors |

## Tool ideas

- `courtlistener_search_opinions` — full-text search across 9M+ opinions
- `courtlistener_get_opinion` — full opinion text by ID
- `courtlistener_search_dockets` — RECAP docket search
- `courtlistener_get_docket` — docket entries and documents
- `courtlistener_search_judges` — judge lookup by name, court, appointer
- `courtlistener_get_citations` — citation network for an opinion
- `courtlistener_search_oral_arguments` — audio recording search

## Licensing (audited 2026-05-25)

- **Status: Caution — rate limits require membership for hosted proxy**
- Court opinions are government works = public domain. Bulk data carries **Public Domain Mark** (CC PDM 1.0)
- ToS does not prohibit proxying or redistribution
- **Bottleneck**: the published free-tier limits (5 req/min, 50/hr, 125/day) are tight whatever a given token actually gets — a hosted proxy exhausts them quickly
- Free Law Project membership ($10+/mo) unlocks higher limits; commercial partnerships also available
- Contact: https://www.courtlistener.com/contact/?issue_type=partnerships
- Alternative: build for local-only use where each user provides their own CourtListener token

## Notes

- Previous session incorrectly said "audio only" — the primary corpus is 9M+ full-text written opinions
- Free tier rate limits are tight whatever the exact per-token ceiling — design tools to be efficient, batch where possible
- RECAP data is crowd-sourced from PACER — coverage varies by court
- Citation network enables "trace legal precedent" workflows
