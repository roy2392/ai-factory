# Plan

## Who does what
| Role | Owner | Output |
|---|---|---|
| Planning, architecture, specs, all Markdown, skills, agent definitions, review of code | Claude | `docs/`, `skills/`, `templates/**.md`, `AGENTS.md` |
| Code: TypeScript, workflows, tests, YAML templates | Codex (`gpt-6-astra`, high) | `src/`, `test/`, `.github/`, `templates/**.yml` |
| GitHub setup, secrets, approving merges | Human | see `docs/SETUP.md` |

Loop per phase: Claude writes `docs/specs/phase-N-*.md` → Codex implements → Claude reviews against
the spec and the acceptance criteria → fixes go back to Codex (resume) → phase done.

## Phases
| # | Phase | Spec | Status |
|---|---|---|---|
| 1 | Foundation + core loop (issue → Copilot → PR → auto-merge) | [phase-1](specs/phase-1-foundation-core-loop.md) | **done** (c988b51) |
| 2 | `/ai` commands and the plan gate | [phase-2](specs/phase-2-commands-plan-gate.md) | **done** |
| 3 | Self-heal and watchdog | [phase-3](specs/phase-3-self-heal-watchdog.md) | **done** |
| 4 | Requirements engine (sub-issues, dependencies, release) | [phase-4](specs/phase-4-requirements.md) | in progress (Codex) |
| 5 | Rollout: showcase repo, eval set, metrics | [phase-5](specs/phase-5-rollout.md) | spec ready (mostly human) |

## Definition of done (every phase)
- All acceptance criteria in the spec are met, and the tests named in the spec exist and pass.
- `lint`, `typecheck`, `test` and `actionlint` pass.
- Claude has reviewed the diff against the spec and `AGENTS.md`.
- Anything that can only be checked on GitHub is listed in `docs/VERIFY.md` for the human smoke test.

## Risks
| Risk | Mitigation |
|---|---|
| Copilot APIs change (assignment, custom agents, CLI flags) | All Copilot calls in `src/copilot.ts`; CLI flags in one helper; check against docs each phase |
| Workflows on Copilot PRs wait for "Approve and run" | Setting in SETUP §4.3; watchdog surfaces stuck PRs |
| Premium-request cost | `max_open`, concurrency groups, fix-attempt cap, plan gate for big issues |
| Prompt injection via issue text | CLI jobs hold no write token; outputs validated; humans approve merges |
| Sub-issue/dependency API limits (number of sub-issues, rate limits) | ≤ 15 tasks per run; throttling plugin |
