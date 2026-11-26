# Architecture

## 1. Goals and non-goals

**Goals**
- Issue → merged PR behind a configurable merge gate: required CI plus Copilot code review, and optionally
  human approvals (`required_approving_review_count` in the ruleset).
- Everything runs in GitHub: Actions, Copilot coding agent, Copilot CLI, Copilot code review.
- One factory repo serves many target repos through reusable workflows and a per-repo config file.
- The model never holds a credential that can push, merge or create issues (same as piomin's design).
- All state lives in GitHub (issues, sub-issues, dependencies, labels, hidden markers). No database.

**Non-goals**
- Self-hosted models, GPUs or clusters.
- Bypassing the merge gate. Auto-merge only fires after the ruleset's required checks and reviews pass.
- Supporting forks or outside contributors as triggers.

## 2. Mapping from piomin/ai-software-factory

| piomin | here |
|---|---|
| Tekton EventListener + CEL filters | Workflow `on:` triggers + `src/filters.ts` |
| PipelineRun | Workflow run (reusable workflow in this repo) |
| OpenCode + Qwen on vLLM | Copilot coding agent (implementation) and Copilot CLI (planning, answers, requirements) |
| Agent image | `copilot-setup-steps.yml` in the target repo |
| Skills OCI artifact | `skills/` in this repo (CLI steps) and `.github/skills/` in target repos (coding agent) |
| `plan` step | Optional plan gate: Copilot CLI posts a plan, `/ai go` releases it |
| `verify` + fix loop | Copilot runs tests in its session, then required CI, then `self-heal` |
| `publish` | Copilot opens the PR; `automerge` enables auto-merge when it is ready |
| `report-failure` | `watchdog` (stale or failed sessions) |
| requirements CronJob + state comment | `requirements` workflow + sub-issues + blocked-by dependencies + state marker |

## 3. Flows

### 3.1 New issue (`reusable-dispatch.yml`, trigger `issues: opened | labeled`)
1. Load `.github/ai-factory.yml` from the target repo (defaults if missing).
2. Filter (`src/filters.ts`): author association in `allowed_associations`; author is not a bot;
   issue is open; it has no skip label (`ai:manual`, `requirements`); it is not already assigned to
   Copilot; its body has no task marker (task issues belong to the requirements flow, 3.8).
3. If the plan gate applies (label `ai:needs-plan`, or `plan_gate: always`) → **plan** (3.3).
4. Otherwise **assign to Copilot** (`src/copilot.ts`), with `custom_agent` = `config.agents.implementer`,
   `base_branch` = `config.base_branch`, `model` = `config.model` (optional), and custom instructions
   that link the issue and repeat the rules ("run the tests, report honestly").
5. Add label `ai:in-progress`.

### 3.2 `/ai` commands on issues (`reusable-ai-command.yml`, trigger `issue_comment: created`)
Only on issues (not PRs), from users in `allowed_associations`, never from bots.

| Command | Action |
|---|---|
| `/ai ask <question>` | Copilot CLI, read-only, answers using the repo + issue thread; the App posts the answer. |
| `/ai do <instruction>` | Assign to Copilot with the instruction as `custom_instructions`. |
| `/ai plan` | Run the plan step (3.3) on demand. |
| `/ai go` | Release a gated issue: assign to Copilot with the latest plan comment as instructions. |
| `/ai stop` | Remove the Copilot assignee and label `ai:manual`. |

Unknown commands get a short help reply. The App reacts with 👀 on every accepted command.

### 3.3 Plan step (inside dispatch / ai-command)
Copilot CLI in a job with **no GitHub write token** (checkout with `persist-credentials: false`, only
`COPILOT_GITHUB_TOKEN` set) writes `out/plan.md`: a `- [ ]` checklist, affected files, risks, open
questions. A second job (App token) posts it as a comment with marker `<!-- ai-factory:plan -->` and
labels `ai:plan-ready`. If the plan lists open questions, it labels `ai:needs-info` instead.

### 3.4 PR conversation (native)
Reviewers write `@copilot …` in PR comments or reviews. Copilot pushes to the same branch. The
`review-triage` custom agent (template) tells it to check each remark against the code and to list
what it did not do and why. Nothing to build here beyond the template.

### 3.5 Auto-merge (`reusable-automerge.yml`, trigger `pull_request_target: ready_for_review | opened`)
If the PR author is the Copilot coding agent and the head branch is in the same repo: enable auto-merge
(`config.merge_method`), add label `ai:awaiting-review`, and request reviewers from `config.reviewers`.
`pull_request_target` is safe here because the workflow **never checks out PR code**.

### 3.6 Self-heal (`reusable-self-heal.yml`, trigger `workflow_run: completed`)
If the run failed, its head branch belongs to an open Copilot PR, and the PR's fix-attempt counter
(labels `ai:fix-1..N`) is below `config.max_fix_attempts`: download the failed job's log tail (last 150
lines per failed job, capped at 20 kB), increment the label and post
`@copilot CI failed in <workflow>/<job>. Fix it. Log tail: …` **as the bot user** (Copilot only acts on
mentions from users with write access, so the App identity will not work). At the limit, label
`ai:human-needed` and mention `config.escalate_to`.

### 3.7 Watchdog (`reusable-watchdog.yml`, trigger `schedule` every 30 min)
- Copilot PR still draft with no activity for `config.stale_hours` → comment once, label `ai:stale`.
- Issue labeled `ai:in-progress` with no linked PR after `config.stale_hours` → comment once,
  label `ai:stale`.
- Closed or merged Copilot PR → remove `ai:in-progress` from the linked issue.

### 3.8 Requirements (`reusable-requirements.yml`, trigger `schedule` hourly + `issues: edited | labeled`)
For each open issue labeled `requirements`, compute the mode from GitHub state (`src/requirements/`):

| Mode | When | Does |
|---|---|---|
| `analyze` | body hash differs from the state marker, or no marker | Copilot CLI + `skills/requirements-breakdown` writes `out/issues.json`; validate; create sub-issues. An empty result with nothing open closes the issue |
| `release` | some sub-issue is not started and all its blockers are closed | assign ready sub-issues to Copilot, at most `max_open` in progress |
| `review` | every sub-issue closed (or none), `reviewed_hash` ≠ current hash, fewer than 3 review rounds | Copilot CLI looks for gaps; none → close the requirements issue; gaps → new sub-issues and another round. After 3 rounds → `ai:human-needed` |
| `idle` | otherwise | nothing |

- **Task issues** are real sub-issues of the requirements issue. Each body ends with
  `<!-- ai-factory:task req=<N> id=<task-id> -->`. Dependencies use GitHub's native "blocked by".
- **State marker** is one App comment on the requirements issue, updated in place:
  `<!-- ai-factory:req-state {"hash":"…","reviewed_hash":"…","version":1} -->` plus a human-readable
  table (task, issue, status).
- **Validation** (`src/requirements/validate.ts`) before anything is created: JSON array, schema, unique
  ids (`^[a-z0-9-]{1,40}$`), titles ≤ 120 chars, non-empty bodies, `depends_on` refers to known ids
  (new or existing), no cycles, at most 15 tasks, no id that already exists.
- **Idempotency**: tasks are matched by marker, never by title. A rerun with the same state does nothing.
  A concurrency group per requirements issue prevents parallel runs.
- Task issues are opened by the App (a bot) and carry the task marker, so dispatch (3.1) ignores them.
  Only `release` assigns them, so the dependency order holds.

## 4. Identities and tokens

| Secret | Identity | Used for | Never used for |
|---|---|---|---|
| `FACTORY_APP_ID`, `FACTORY_APP_PRIVATE_KEY` | GitHub App (`ai-factory[bot]`) | comments, labels, creating sub-issues and dependencies, enabling auto-merge, reading logs | assigning Copilot, `@copilot` mentions |
| `COPILOT_ASSIGN_TOKEN` | fine-grained PAT of the bot **user** with a Copilot seat | assigning issues to Copilot, `@copilot` fix comments | anything the App can do |
| `COPILOT_CLI_TOKEN` | fine-grained PAT of the bot user with the "Copilot Requests" permission | `COPILOT_GITHUB_TOKEN` for Copilot CLI steps only | GitHub API calls |

Rule: a job that runs Copilot CLI receives **only** `COPILOT_CLI_TOKEN`, a checkout with
`persist-credentials: false` and `permissions: contents: read`. Writing to GitHub happens in a separate
job that reads the CLI output as an artifact and validates it first.

## 5. Security model
- Triggers accept only `OWNER`, `MEMBER`, `COLLABORATOR` (configurable). Bots never trigger anything.
- No fork PRs; `pull_request_target` and `workflow_run` jobs never check out or execute PR code.
- Model output that becomes a GitHub write (issues.json, plan, answer) is validated and size-capped,
  and markdown is posted as-is, never executed.
- Issue text is untrusted input to Copilot. Keep the Copilot agent firewall on; `copilot-setup-steps`
  only adds the registries the build needs.
- The Copilot coding agent can push only to `copilot/*` branches. Branch rulesets require a review from
  someone other than the person who started the session, plus status checks.
- Every workflow sets the least `permissions:` it needs at job level.
- Third-party actions are pinned to a full commit SHA.

## 6. Key decisions
1. **Explicit `/ai ask|do` instead of an intent classifier.** Predictable, testable, cheap.
2. **Native sub-issues and dependencies instead of a JSON state comment.** Humans see progress in the
   GitHub UI; only the body hash needs a marker.
3. **Copilot CLI for planning, answers and requirements; coding agent for code.** The coding agent always
   produces a PR, so it cannot do read-only work.
4. **Reusable workflows plus a thin caller per repo** instead of copying workflows, so the factory can be
   upgraded in one place (pin the caller to a tag).
5. **Two bot identities.** The App is auditable and short-lived; the user PAT is only used where GitHub
   requires a licensed user (Copilot assignment, mentions, CLI).
