/**
 * @fileoverview Bundle cleaning preserves runtime modules beneath nested skills paths.
 * @module tests/packaging/agent-doc-entries
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY as cleaner } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as linter } from '../../scripts/lint-packaging.js';

describe('dependency agent documentation', () => {
  it.each([cleaner, linter])('preserves SDK runtime skills modules', (pattern) => {
    expect(pattern.test('node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js')).toBe(
      false,
    );
    expect(
      pattern.test(
        'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
      ),
    ).toBe(false);
  });

  it.each([cleaner, linter])(
    'removes package-root agent docs, including nested packages',
    (pattern) => {
      expect(
        pattern.test('node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md'),
      ).toBe(true);
      expect(pattern.test('node_modules/outer/node_modules/inner/skills/helper/SKILL.md')).toBe(
        true,
      );
      expect(pattern.test('node_modules/inner/SKILL.md')).toBe(true);
      expect(pattern.test('skills/research/SKILL.md')).toBe(false);
    },
  );
});
