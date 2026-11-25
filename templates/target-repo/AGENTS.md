# AGENTS.md

Rules for AI coding agents (GitHub Copilot coding agent, Copilot CLI) working in this repository.
Adapt every `<…>` placeholder to this project, and keep this file short and true.

## Project
- What it is: <one sentence>.
- Layout: <module or folder → purpose, one line each>.
- Stack: <language/version, framework, build tool>.

## Build and test
- Build: `<mvn -B verify | npm ci && npm test | …>`
- Fast tests only: `<command>`
- Lint/format: `<command>`
- **Run the build and the tests before you finish.** Report the exact command and the real result in the
  PR description. If something fails and you could not fix it, say so plainly. Never report a check you
  did not run.

## Conventions
- <naming, package structure, error handling, logging>
- Tests: every behaviour change comes with a test in `<path>`; use `<framework>`.
- Database changes: a new migration in `<path>`; never edit an applied migration.
- Public API changes: update `<openapi file / docs>` in the same PR.

## Scope
- Do only what the issue or task asks. No unrelated refactoring, renames or dependency upgrades.
- A task that is part of a requirements issue: do **only** that task, even if you see the next one.
- If the issue is ambiguous, state your assumption at the top of the PR description.

## Never
- Edit generated or build output: `<target/, dist/, …>`.
- Commit secrets, tokens or `.env` files.
- Disable or skip tests to make the build pass.
- Change CI workflows under `.github/workflows/` unless the issue asks for it.
