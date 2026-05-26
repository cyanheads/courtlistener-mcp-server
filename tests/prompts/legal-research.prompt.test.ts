/**
 * @fileoverview Tests for the legal-research prompt.
 * @module tests/prompts/legal-research.prompt.test
 */

import { describe, expect, it } from 'vitest';
import { legalResearchPrompt } from '@/mcp-server/prompts/definitions/legal-research.prompt.js';

describe('legalResearchPrompt', () => {
  it('generates valid messages for valid args', () => {
    const args = legalResearchPrompt.args!.parse({
      topic: 'Fourth Amendment cell phone search',
    });
    const messages = legalResearchPrompt.generate(args);
    expect(messages).toBeInstanceOf(Array);
    expect(messages.length).toBeGreaterThan(0);
    for (const msg of messages) {
      expect(msg).toHaveProperty('role');
      expect(msg).toHaveProperty('content');
    }
  });

  it('includes the topic in the generated message', () => {
    const args = legalResearchPrompt.args!.parse({
      topic: 'qualified immunity Section 1983',
    });
    const messages = legalResearchPrompt.generate(args);
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain('qualified immunity Section 1983');
  });

  it('includes jurisdiction in the message when provided', () => {
    const args = legalResearchPrompt.args!.parse({
      topic: 'free speech',
      jurisdiction: 'ca9',
    });
    const messages = legalResearchPrompt.generate(args);
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain('ca9');
  });

  it('includes deep research steps when depth is deep', () => {
    const args = legalResearchPrompt.args!.parse({
      topic: 'strict scrutiny',
      depth: 'deep',
    });
    const messages = legalResearchPrompt.generate(args);
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain('courtlistener_get_citations');
    expect(text).toContain('courtlistener_get_judge');
  });

  it('generates overview plan without deep steps by default', () => {
    const args = legalResearchPrompt.args!.parse({ topic: 'due process' });
    const messages = legalResearchPrompt.generate(args);
    const text = (messages[0].content as { text: string }).text;
    expect(text).toContain('courtlistener_search_opinions');
    // Deep steps should not appear in overview
    expect(text).not.toContain('courtlistener_get_citations');
  });
});
