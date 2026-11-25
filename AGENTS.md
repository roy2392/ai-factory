# Rules for coding agents working on this repository

This repository is built by a coding agent (Codex) from specs written by a planner (Claude).
**The specs in `docs/specs/` are the source of truth.** If a spec is unclear or wrong, do not guess:
implement the safest reading, and list the issue under "Open questions" in your final report.

## Stack
- Node.js 24, TypeScript (strict), ES modules.
- Run TypeScript directly with `tsx`. No build step, no bundler.
- `@octokit/rest` plus `@octokit/plugin-retry` and `@octokit/plugin-throttling` for the GitHub API,
  `yaml` for config, `zod` for validation.
- Tests: Vitest. Lint: ESLint (typescript-eslint) + Prettier. Workflows: `actionlint`.
- Do not add other runtime dependencies without listing why in your report.

## Layout
```
src/
  cli.ts                 single entrypoint: `tsx src/cli.ts <command> [--flags]`
  config.ts              load + validate .github/ai-factory.yml (docs/CONFIG.md)
  context.ts             read GITHUB_EVENT_PATH / env into a typed event
  filters.ts             who/what is allowed to trigger (pure functions)
  labels.ts              label names, colors, descriptions (single source)
  markers.ts             build/parse hidden <!-- ai-factory:… --> markers
  github/                thin GitHub client interface + Octokit implementation
  copilot.ts             assign to Copilot, build custom instructions
  commands/              one file per CLI command (dispatch, ai-command, automerge, self-heal, watchdog, requirements, labels)
  requirements/          pure engine: mode, validate, graph, release selection, state
test/                    mirrors src/, plus fixtures/ with real-shaped webhook payloads
.github/workflows/       reusable-*.yml (workflow_call) + ci.yml for this repo
```

## Design rules
1. **Pure core, thin IO.** Decisions (filters, mode, validation, release order, command parsing) are
   pure functions with unit tests. IO goes through the `GitHubClient` interface in `src/github/`, so
   tests use an in-memory fake, never the network.
2. **Every GitHub write is idempotent.** Look for the marker or label first; rerunning a workflow must not
   double-comment, double-assign or create duplicate issues.
3. **No secrets in logs.** Never print tokens, env or full payloads. Use `core`-style `::add-mask::` for
   anything derived from a secret.
4. **Least privilege in workflows.** `permissions: {}` at the top, then per job. A job that runs Copilot
   CLI gets only `contents: read` and `COPILOT_GITHUB_TOKEN`; it checks out with
   `persist-credentials: false` and must not have `GH_TOKEN`/`GITHUB_TOKEN` in its env.
5. **Never check out PR code** in `pull_request_target` or `workflow_run` workflows.
6. Pin third-party actions to a full commit SHA with the version in a trailing comment.
   `actions/*` and `github/*` may use a major tag.
7. Every reusable workflow has `concurrency` set (per issue or per PR) and a `timeout-minutes`.
8. User-facing comments start with a short bold line and end with the marker. Keep them under 60 kB.

## Commands that must pass before you finish
```
npm ci
npm run lint
npm run typecheck
npm test
npx actionlint            # or the actionlint binary; report if it cannot be installed
```
Report the real result of each command. If something fails and you cannot fix it, say so.

## Final report (print at the end of every task)
- Files created or changed
- Results of the commands above
- Deviations from the spec, with reasons
- Open questions for the planner
- What a human must do or verify on GitHub (things that cannot be tested locally)
