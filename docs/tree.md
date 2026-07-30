# courtlistener-mcp-server - Directory Structure

Generated on: 2026-07-30 04:31:08

```text
courtlistener-mcp-server/
├── .agents/
├── .claude/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   │       └── legal-research.prompt.ts
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       └── courts-reference.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── get-citations.tool.ts
│   │           ├── get-docket.tool.ts
│   │           ├── get-financial-disclosure.tool.ts
│   │           ├── get-judge.tool.ts
│   │           ├── get-opinion.tool.ts
│   │           ├── get-oral-argument.tool.ts
│   │           ├── get-parties.tool.ts
│   │           ├── lookup-citation.tool.ts
│   │           ├── lookup-courts.tool.ts
│   │           ├── search-dockets.tool.ts
│   │           ├── search-financial-disclosures.tool.ts
│   │           ├── search-judges.tool.ts
│   │           ├── search-opinions.tool.ts
│   │           └── search-oral-arguments.tool.ts
│   ├── services/
│   │   └── courtlistener/
│   │       ├── codes.ts
│   │       ├── court-names-data.ts
│   │       ├── court-names.ts
│   │       ├── courtlistener-service.ts
│   │       ├── dates.ts
│   │       ├── types.ts
│   │       └── uri.ts
│   └── index.ts
├── tests/
│   ├── prompts/
│   │   └── legal-research.prompt.test.ts
│   ├── resources/
│   │   └── courts-reference.resource.test.ts
│   ├── service/
│   │   ├── codes.test.ts
│   │   ├── court-names.test.ts
│   │   ├── courtlistener-service.retry.test.ts
│   │   ├── courtlistener-service.test.ts
│   │   ├── dates.test.ts
│   │   └── uri.test.ts
│   ├── tools/
│   │   ├── get-citations.tool.test.ts
│   │   ├── get-docket.tool.test.ts
│   │   ├── get-financial-disclosure.tool.test.ts
│   │   ├── get-judge.tool.test.ts
│   │   ├── get-opinion.tool.test.ts
│   │   ├── get-oral-argument.tool.test.ts
│   │   ├── get-parties.tool.test.ts
│   │   ├── lookup-citation.tool.test.ts
│   │   ├── lookup-courts.tool.test.ts
│   │   ├── search-dockets.tool.test.ts
│   │   ├── search-financial-disclosures.tool.test.ts
│   │   ├── search-judges.tool.test.ts
│   │   ├── search-opinions.tool.test.ts
│   │   └── search-oral-arguments.tool.test.ts
│   └── security.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
