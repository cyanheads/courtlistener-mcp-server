/**
 * @fileoverview Legal research workflow prompt for CourtListener.
 * @module mcp-server/prompts/definitions/legal-research.prompt
 */

import { prompt, z } from '@cyanheads/mcp-ts-core';

export const legalResearchPrompt = prompt('courtlistener_research_topic', {
  description:
    'Generate a structured legal research plan for a given legal topic or question. Produces a step-by-step workflow using CourtListener tools to find relevant case law, trace precedent chains, and surface key opinions.',
  args: z.object({
    topic: z
      .string()
      .describe(
        'Legal topic, question, or issue to research (e.g., "Fourth Amendment cell phone search", "Title VII hostile work environment", "Section 1983 qualified immunity").',
      ),
    jurisdiction: z
      .string()
      .optional()
      .describe(
        'Optional jurisdiction to focus on (e.g., "scotus" for Supreme Court, "ca9" for Ninth Circuit, "nyed" for SDNY). Omit for nationwide research.',
      ),
    depth: z
      .enum(['overview', 'deep'])
      .optional()
      .default('overview')
      .describe(
        '"overview" (default): find 3–5 key cases. "deep": include citation network traversal and judge lookup. Note: deep research uses more of the 125 req/day free-tier budget.',
      ),
  }),
  generate: (args) => {
    const jurisdictionNote = args.jurisdiction
      ? ` focused on ${args.jurisdiction}`
      : ' across all jurisdictions';
    const depthNote =
      args.depth === 'deep'
        ? '\n\nFor deep research, also:\n4. For the top 2–3 opinions, call courtlistener_get_citations(direction="cited_by") to trace how the precedent has been applied or distinguished.\n5. Call courtlistener_get_judge to look up the authoring judge\'s appointment history and affiliations.\n6. Summarize the precedent trajectory: which courts have adopted vs. distinguished the landmark ruling.'
        : '';

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Research the following legal topic using CourtListener${jurisdictionNote}:

**Topic:** ${args.topic}

Follow this research workflow:

1. Start with courtlistener_search_opinions to find key cases on this topic${args.jurisdiction ? ` in ${args.jurisdiction}` : ''}. Use relevant legal terminology in the query. Try both exact phrases (caseName:) and plain-text searches.

2. For the 2–3 most relevant opinions, call courtlistener_get_opinion to read the full text and understand the court's reasoning.

3. Use courtlistener_lookup_citation if you encounter a specific citation string (e.g., "410 U.S. 113") that you want to trace directly.${depthNote}

Present findings as:
- **Key Cases**: cluster ID, case name, court, date, citation count, and a 1–2 sentence summary of the holding
- **Precedent Trajectory** (if deep): which courts have applied, distinguished, or limited the ruling
- **Research Gaps**: what questions remain unanswered and what additional searches would address them

Rate limit note: CourtListener publishes free-tier limits of 5 req/min, 50/hr, 125/day, though actual limits vary by token tier — pace your tool calls and honor the Retry-After returned on a 429.`,
        },
      },
    ];
  },
});
