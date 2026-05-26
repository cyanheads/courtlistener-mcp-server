# courtlistener-mcp-server - Directory Structure

Generated on: 2026-05-26 03:15:35

```text
courtlistener-mcp-server/
├── .claude/
├── .github/
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.yml
│       ├── config.yml
│       └── feature_request.yml
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skills-sync.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
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
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── migrate-mcp-ts-template/
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
│   │           ├── get-judge.tool.ts
│   │           ├── get-opinion.tool.ts
│   │           ├── lookup-citation.tool.ts
│   │           ├── lookup-courts.tool.ts
│   │           ├── search-dockets.tool.ts
│   │           ├── search-judges.tool.ts
│   │           ├── search-opinions.tool.ts
│   │           └── search-oral-arguments.tool.ts
│   ├── services/
│   │   └── courtlistener/
│   │       ├── courtlistener-service.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── prompts/
│   │   └── legal-research.prompt.test.ts
│   ├── resources/
│   │   └── courts-reference.resource.test.ts
│   └── tools/
│       ├── get-citations.tool.test.ts
│       ├── get-docket.tool.test.ts
│       ├── get-judge.tool.test.ts
│       ├── get-opinion.tool.test.ts
│       ├── lookup-citation.tool.test.ts
│       ├── lookup-courts.tool.test.ts
│       ├── search-dockets.tool.test.ts
│       ├── search-judges.tool.test.ts
│       ├── search-opinions.tool.test.ts
│       └── search-oral-arguments.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── .mcpbignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
