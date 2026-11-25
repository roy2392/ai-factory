# Phase 3: self-heal and watchdog

Read first: `docs/ARCHITECTURE.md` §3.6, §3.7.

## 1. `self-heal` command
Trigger: `workflow_run.completed` (the caller lists the CI workflow names to watch in
`workflow_run.workflows`).
1. Skip unless `conclusion` ∈ {`failure`, `timed_out`}; `event` is `pull_request`; head repo = base repo.
2. Find the open PR for `head_branch` (app client). Skip unless the author is Copilot.
3. Skip if the PR head SHA ≠ `workflow_run.head_sha` (a newer push exists; the run is stale).
4. Idempotency: skip if a comment with marker `self-heal run=<workflow_run.id>` exists.
5. `attempt = fixAttemptOf(labels)`. If `attempt >= config.max_fix_attempts`:
   label `ai:human-needed`, comment once (marker `self-heal state=gave-up`) mentioning `config.escalate_to`
   and linking the run, then exit.
6. Log tail (`src/logs.ts`, pure part tested): list the run's jobs, take failed jobs (max 3), download each
   job log, keep the last 150 lines, strip ANSI codes and timestamps, redact anything matching
   `ghp_|github_pat_|ghs_|-----BEGIN` (whole line → `[redacted]`), cap total at 20 000 chars.
7. Replace `ai:fix-<attempt>` with `ai:fix-<attempt+1>` (app client).
8. Post the comment **with the user client** (Copilot only reacts to mentions from users with write access):

   ```
   @copilot CI failed: <workflow name> / <job names> (attempt N of MAX). Fix the cause, run the
   build and tests, and push. If the failure is not caused by this PR, say so and do not change code.
   <details><summary>Log tail</summary> ```text … ``` </details>
   <!-- ai-factory:self-heal run=<id> attempt=<N> -->
   ```

Workflow `reusable-self-heal.yml`: secrets as before (app + user tokens); permissions
`actions: read`, `pull-requests: write`, `issues: write`; **no checkout of the target repo**; concurrency
`ai-factory-pr-<head_branch>`; timeout 10.

## 2. `watchdog` command
Trigger: `schedule` (caller: `*/30 * * * *`) and `workflow_dispatch`.
1. Open PRs authored by Copilot, draft, `updated_at` older than `stale_hours` → if no `stale` marker
   newer than the last PR update: comment (marker `stale kind=pr`), label `ai:stale`, mention the issue author.
2. Open issues labeled `ai:in-progress`, assigned to Copilot, with no linked open PR
   (search `is:pr is:open author:app/copilot-swe-agent linked:issue` is unreliable; instead scan the
   Copilot PRs from step 1 for `Fixes #N` and the issue's timeline `cross-referenced` events), older than
   `stale_hours` → comment once (marker `stale kind=issue`), label `ai:stale`.
3. Closed or merged Copilot PR whose linked issue still has `ai:in-progress` → remove `ai:in-progress`
   and `ai:awaiting-review`.
4. `ai:stale` is removed by `automerge` when the PR becomes ready (add this to Phase 1's automerge).
5. Process at most 50 items per run; log a summary table.

Pure parts (`src/watchdog.ts`): `isStale(updatedAt, now, hours)`, `needsStaleComment(markers, lastUpdate)`,
`linkedIssues(prBody)` (reuse the Phase 1 parser).

Workflow `reusable-watchdog.yml`: app token only; `issues: write`, `pull-requests: write`; timeout 15.

Template caller: add `workflow_run` (with a `workflows: [CI]` placeholder) and `schedule`.

## 3. Tests
- `logs.test.ts`: tail length, ANSI/timestamp stripping, redaction, total cap across 3 jobs.
- `self-heal.test.ts`: each skip (conclusion, fork, non-Copilot, stale SHA, duplicate run); attempt label
  rotation; give-up path posts once; the fix comment goes through the **user** client, labels through the app client.
- `watchdog.test.ts`: stale draft PR; repeated runs do not re-comment; issue without PR; cleanup after merge; 50-item cap.

## 4. Acceptance criteria
- [ ] All tests and checks pass.
- [ ] No step in either workflow checks out or runs code from the PR.
- [ ] `docs/VERIFY.md` gains: failing CI on a Copilot PR → fix comment → Copilot pushes; give-up after
      `max_fix_attempts`; stale PR comment.
