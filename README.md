# AI Factory on GitHub + Copilot

A "software factory" that turns GitHub issues, comments and requirements into reviewed, merged pull
requests, built **only** from GitHub-native pieces: GitHub Actions, the Copilot coding agent, Copilot
CLI, Copilot code review, sub-issues, issue dependencies and rulesets.

Inspired by [piomin/ai-software-factory](https://github.com/piomin/ai-software-factory), which does the
same on OpenShift + Tekton + vLLM + OpenCode. Here there is no cluster, no GPU and no webhook endpoint:
every moving part runs inside GitHub.

```
Issue opened ──► dispatch ──► (plan gate?) ──► Copilot coding agent ──► draft PR
                                                     │
PR ready ──► Copilot code review + CI + human approval ──► auto-merge ──► issue closed
"@copilot …" on PR ──► Copilot pushes to the same PR (native)
CI red on copilot/* ──► self-heal ──► "@copilot fix …" (max N)
"/ai ask|do|go" on issue ──► answer / implement / approve plan
"requirements" issue ──► planner ──► sub-issues with blocked-by ──► released 3 at a time ──► Copilot
```

## How it is organised

| Path | What it is |
|---|---|
| `.github/workflows/reusable-*.yml` | The factory. Reusable workflows (`on: workflow_call`) that target repos call. |
| `src/` | TypeScript logic used by the workflows (filters, config, requirements engine, GitHub client). |
| `test/` | Unit tests (Vitest) for everything in `src/`. |
| `skills/` | Skills used by the Copilot CLI steps (requirements breakdown, review triage). |
| `templates/target-repo/` | Files copied into each repository the factory works on. |
| `docs/` | Plan, architecture, setup guide and implementation specs. |

## Documents

- [docs/PLAN.md](docs/PLAN.md): phases, status, and how the work is split between Claude and Codex
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): flows, components, security model, decisions
- [docs/SETUP.md](docs/SETUP.md): one-time manual setup (Copilot, GitHub App, bot user, rulesets)
- [docs/CONFIG.md](docs/CONFIG.md): per-repository `.github/ai-factory.yml` reference
- [docs/specs/](docs/specs/): implementation specs, one per phase (the input for Codex)
- [AGENTS.md](AGENTS.md): rules for any coding agent working **on this repository**
