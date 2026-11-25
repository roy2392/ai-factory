# Phase 5: rollout, evaluation and metrics

Mostly human work. Codex only does §3 (metrics script).

## 1. Showcase repository
- Create `ai-factory-showcase`: a small Spring Boot (or your stack) service with tests and CI.
- Copy `templates/target-repo/`, set `OWNER` in the caller, tag the factory `v1`.
- Run `docs/SETUP.md` end to end and tick every item in `docs/VERIFY.md`.

## 2. Requirements smoke test
Open an issue labeled `requirements` with three related features (for example: entity + REST API +
UI screen). Expect: a state comment and sub-issues with blocked-by links within an hour (or trigger
`workflow_dispatch`); at most 3 assigned at once; the next task released after a merge; the requirements
issue closed after the review pass.

## 3. Metrics (`factory metrics --repo … --since 30d`, Codex)
Read-only command printing a markdown table and writing `metrics.json`:
- Copilot PRs opened / merged / closed unmerged
- median hours from issue opened to PR merged
- share of merged PRs that needed 0 human-requested changes (no `@copilot` comment from a human)
- self-heal: attempts per PR, share that gave up
- requirements: tasks created / closed, issues fully closed
Add an optional `reusable-metrics.yml` (weekly) that writes the table to the job summary.

## 4. Evaluation set
- 10–20 reference issues in the showcase repo with known-good solutions, labeled `eval`.
- Re-run them (close, delete the branch, reopen) when you change the model, the custom agents, the
  skills or `AGENTS.md`. Compare: merged without changes, CI green on the first try, review comments.

## 5. Scale out
- Add the caller to more repos; pin `@v1`; upgrade by moving the tag after the showcase passes.
- Move shared custom agents into the org `.github-private` repository so every repo gets them.
