# Phase 4: requirements engine

Read first: `docs/ARCHITECTURE.md` §3.8, `skills/requirements-breakdown/SKILL.md`.

## 1. Data model (all in GitHub)
- **Requirements issue**: open, label `requirements`. Its body is the requirements text.
- **State comment**: one comment by the App on the requirements issue with marker
  `req-state {"version":1,"hash":"<sha256 of normalized body>","reviewed_hash":"<hash or empty>","review_rounds":0,"last_run":"<run url>"}`
  plus a human table: `| Task | Issue | Status | Blocked by |`. Updated in place, never duplicated.
- **Task issue**: sub-issue of the requirements issue, opened by the App, body ends with
  `task req=<N> id=<task-id>`. Dependencies: GitHub "blocked by" relations between task issues.
- Normalized body for hashing: CRLF → LF, trailing whitespace trimmed per line, leading and trailing blank
  lines removed.

New `GitHubClient` methods (REST; check the current docs and keep each call in `octokit.ts`):
`listSubIssues(issue)`, `addSubIssue(parent, childId)`, `listBlockedBy(issue)`,
`addBlockedBy(issue, blockerIssueId)`, `createIssue`, `closeIssue`, `listIssuesByLabel`.
Note that sub-issue and dependency endpoints take the **issue id**, not the number.

## 2. Pure engine (`src/requirements/`)
- `state.ts`: `parseState(comments)`, `renderState(state, tasks)`, `hashBody(body)`.
- `tasks.ts`: `Task = { id, issueNumber, issueId, state: "open"|"closed", assignedToCopilot, blockedBy: number[] }`;
  `loadTasks(subIssues, blockedByMap)` keeps only sub-issues with a `task` marker for this requirements issue.
- `mode.ts`: `decideMode({ state, bodyHash, tasks, config })` → `analyze | release | review | idle`:
  1. no state, or `state.hash !== bodyHash` → `analyze`
  2. some task is open, unassigned, all its blockers closed, and fewer than `max_open` tasks are
     open-and-assigned → `release`
  3. every task is closed (zero tasks counts as all closed), `state.reviewed_hash !== bodyHash`, and
     `state.review_rounds < 3` → `review`
  4. else `idle`

  Amendment (planner decision, after Phase 4 review), so a requirements issue can always finish:
  - **Empty analysis:** when `apply-analysis` gets `[]` and no task is open, do not wait for a review run:
    set `reviewed_hash = hash`, comment "**Nothing to implement: the repository already covers these
    requirements.**" (marker `review kind=complete hash=<h>`) and close the issue (`completed`).
  - **Review with gaps:** `apply-review` with a non-empty list creates the tasks, increments
    `review_rounds` and does **not** set `reviewed_hash`. When those tasks close, rule 3 fires again.
  - **Round cap:** when rule 3 would fire but `review_rounds >= 3`: label `ai:human-needed`, comment once
    (marker `review kind=cap hash=<h>`) and stay idle. Editing the body resets `review_rounds` to 0,
    because `analyze` writes a fresh state.
- `validate.ts`: `validateIssuesJson(raw: string, existingIds: Set<string>, maxTasks)` →
  `{ ok: true, tasks } | { ok: false, errors: string[] }`. Rules from architecture §3.8, plus: body
  ≤ 20 000 chars, ≤ 10 dependencies per task. Report **all** errors, not just the first.
- `graph.ts`: `topoSort(tasks)` (deterministic: ties broken by input order), `findCycle(tasks)` returning
  the cycle path for the error message.
- `release.ts`: `selectReleasable(tasks, maxOpen)` → task issues to assign, lowest issue number first,
  only as many as free slots.

## 3. `requirements` CLI command
Triggers: `schedule` (hourly), `workflow_dispatch` (optional input `issue`), `issues.edited` and
`issues.labeled` (label `requirements`) on a requirements issue.
For each requirements issue (or only the given one): decide the mode, then emit a **plan** to
`$GITHUB_OUTPUT` as JSON: `[{ issue, mode }]` (only non-idle). The workflow fans out with a matrix.

Per issue, by mode:
- `analyze`: the `think` job runs Copilot CLI with `skills/requirements-breakdown/SKILL.md` and a prompt
  from `requirementsPrompt(issue, existingTasks)`, where `existingTasks` = `[{id, title, status}]` written
  to `out/existing-tasks.json`. The job also writes `out/requirements.md` (the issue body) and
  `out/mode.txt` (`analyze` or `review`): these are the inputs named in the skill. Output: `out/issues.json`.
  `apply-analysis` (app client): validate → on error, comment the error list once per hash (marker
  `review kind=invalid hash=<h>`) and exit 1. On success: create issues in topological order, add each
  as a sub-issue, add blocked-by relations (`depends_on` may reference existing ids), then write the
  state with the new `hash`. Then run `release` in the same job.
- `release`: `selectReleasable` → for each: `assignToCopilot` (user client) with instructions
  "This task is part of requirements #N. Only do this task." Add `ai:in-progress`. Update the state table.
- `review`: `think` job runs the CLI with `reviewPrompt` (requirements + list of closed tasks + their
  PRs); output `out/issues.json` (an empty array means nothing is missing). `apply-review`: empty → set
  `reviewed_hash`, comment "**All requirements implemented.**" and close the requirements issue
  (`state_reason: completed`). Not empty → same as `apply-analysis`, increment `review_rounds`, leave
  `reviewed_hash` unchanged (see the amendment in §2).

Partial failure: if creating issue K fails, the already-created ones stay (they carry markers), the
state is **not** updated, and the next run continues: `apply-analysis` skips ids that already exist.

## 4. Workflow `reusable-requirements.yml`
```
job scan     (app token, issues: read)                    → matrix JSON
job think    (matrix; mode in [analyze, review]; contents: read; COPILOT_GITHUB_TOKEN only in the CLI step)
             checkout target default branch (persist-credentials: false), copy SKILL.md to
             .github/skills/requirements-breakdown/ in the workspace, run the CLI, upload out/
job apply    (matrix; needs think when needed; app token issues: write + user token for assignment)
```
Concurrency per requirements issue (`ai-factory-req-<n>`), `cancel-in-progress: false`.
Timeouts: scan 5, think 45, apply 15. Matrix `max-parallel: 2`.

Template caller: add `schedule` (hourly), `workflow_dispatch` with input `issue`, and the issues triggers.
Dispatch must ignore `issues.edited` (it already only handles `opened`/`labeled`).

## 5. Tests
- `state.test.ts`: hash normalization (CRLF, trailing spaces); parse/render round trip; table rendering.
- `validate.test.ts`: every rule individually; multiple errors reported together; existing-id clash;
  unknown dependency; cycle message shows the path.
- `graph.test.ts`: deterministic order; dependencies on existing tasks.
- `mode.test.ts`: each mode; precedence (an edited body beats release); `max_open` respected; zero tasks
  counts as all closed; round cap.
- `release.test.ts`: slots, blockers, ordering.
- `requirements.test.ts` (fake client): full lifecycle: analyze creates 4 tasks with dependencies →
  release assigns 3 → close 1 → release assigns the 4th → close all → review with `[]` closes the
  requirements issue. Plus: rerun with the same state writes nothing; partial failure resumes without
  duplicates; edited body → analyze again, existing ids not duplicated; empty first analysis closes the
  issue; review with gaps → gap tasks close → second review `[]` closes the issue; three gap rounds →
  `ai:human-needed` once, no fourth review.

## 6. Acceptance criteria
- [ ] All tests and checks pass.
- [ ] The lifecycle test passes with the fake client, and every write is idempotent on rerun.
- [ ] No CLI job has a write permission.
- [ ] `docs/VERIFY.md` gains the requirements smoke test (from `docs/specs/phase-5-rollout.md` §2).
