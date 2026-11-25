# Factory verification: Phases 1–3

## Local checks

Use Node.js 24 (see `.nvmrc`):

```sh
npm ci
npm run lint
npm run typecheck
npm test
actionlint .github/workflows/*.yml templates/target-repo/.github/workflows/*.yml
npx tsx test/dry-run-fixture.ts
```

The fixture harness invokes the real CLI with `dispatch --dry-run`, reads
`test/fixtures/issues.opened.json`, and supplies in-memory clients. It prints the
planned assignment, label and comment and asserts that no write occurred. Unit
tests and mocked HTTP transport tests never access GitHub.

For a read-only dry-run against a real target repository:

```sh
GITHUB_EVENT_NAME=issues \
GITHUB_REPOSITORY=OWNER/REPO \
GITHUB_EVENT_PATH=/path/to/actual-issue-webhook.json \
npm run factory -- dispatch --dry-run
```

Set `APP_TOKEN` securely in the environment for private-repository reads. A real
dry-run fetches current issue/repository/configuration state; a webhook fixture
alone does not replace those reads. `USER_TOKEN` is not required for dry-run.
Without `--dry-run`, dispatch needs `APP_TOKEN` and `USER_TOKEN` (the latter is
`COPILOT_ASSIGN_TOKEN`); automerge and labels use only `APP_TOKEN`.

## GitHub setup and smoke test (human)

Complete `docs/SETUP.md` sections 1–4 first: enable the coding agent and code
review, give the bot user a Copilot seat and repository write access, install the
App on both repositories, configure secrets, enable auto-merge, and set the
approval/status-check/conversation rules. No live GitHub setup or write is part
of the local tests.

1. Publish the reviewed factory revision under the caller's chosen ref (default
   `v1`). This implementation does not commit, push, or create that tag.
2. Copy the target templates, replace `OWNER`, and customize the existing agent
   Markdown and build setup for the target project. The factory and target must
   share an owner: the specified single App installation token cannot span
   installations in different owners. Verify private reusable-workflow access.
3. Set `reviewers` in `.github/ai-factory.yml`. For user reviewers, set the target
   repository Actions variable `COPILOT_BOT_LOGIN` to the licensed bot user's
   login. It is non-secret. Automerge fails before writing if user reviewers are
   configured but this identity is missing, and never requests that user.
   Team-only reviewers do not need the variable; use teams in the target owner.
4. Create the labels from a local checkout with `APP_TOKEN` securely set:
   `npm run factory -- labels --repo OWNER/REPO`. Repeat once and verify all are
   unchanged. The Phase 1 package is private and is not published to npm.
5. As a trusted human, open **Add a /health endpoint that returns 200 OK**. Expect
   Copilot assigned within about a minute, `ai:in-progress`, and one assignment
   comment. Inspect the dispatch run to confirm App writes versus user-token
   assignment. Rerun it: no duplicate assignment, label or comment.
6. Wait for Copilot's draft PR. Verify it is from Copilot in the same repository
   and targets the configured base branch. While draft, no auto-merge/review
   action should occur. Once ready, expect the selected auto-merge method,
   `ai:awaiting-review`, and the configured human/team review requests. Check the
   actual App can enable auto-merge under the repository's permissions/rules.
7. Verify required checks and a human approval still gate the merge. Complete
   that review in the sandbox target and verify merge/issue closure. Rerun the
   automerge workflow while review requests are pending: no duplicate writes.
8. Check negative cases: a bot/outside-author issue, an `ai:manual` or
   `requirements` issue, and an issue with a task marker do not dispatch. A
   needs-plan issue now follows the Phase 2 plan flow below. A human
   PR, fork PR or PR to a different base branch receives no automerge writes.
9. Inspect run logs: no tokens or full webhook payloads, and factory checkout
   only in `pull_request_target`. The automerge job has no user token.

Requirements execution is a later phase. Phase 2 command/planning and Phase 3
self-heal/watchdog checks are below.

## Accepted Phase 1 interpretations

The planner accepted these interpretations after reviewing commit `c988b51`.

- The marker spec says to escape `>` as `>` while also forbidding `-->` in JSON.
  This implementation uses the JSON escape `\u003e` and restores the original
  text on parse.
- The config spec has no bot-user login. `COPILOT_BOT_LOGIN` is the minimal
  non-secret addition used to honor “never request the bot user” without giving
  automerge the assignment token. Set it as an organization variable as described
  in `docs/SETUP.md` (a repository variable also works).
- A single installation token is scoped to one owner; cross-owner targets fail
  explicitly before checkout; the same-owner requirement is documented in setup.
- Linked issue references are parsed and reported, without mutating the issue:
  Phase 1 specifies no linked-issue write. Phase 3 adds removing `ai:stale` on
  ready PRs in automerge and linked-issue cleanup through watchdog.
- Within automerge step 3, reviewers are requested before adding
  `ai:awaiting-review`. The label marks completed review setup, preventing reruns
  from requesting already-completed reviews after GitHub clears the pending
  lists. To intentionally apply a changed reviewer configuration, remove that
  label and rerun.
- Reusable commands run inside `.factory` as `npx --no-install tsx src/cli.ts`
  so they use the installed factory dependencies. This is equivalent to the
  specified path from the workspace root without resolving a fresh `tsx` there.

Local verification does not establish Copilot entitlement, PAT/App permissions,
private workflow access, review policies, or a successful live issue-to-merge run.

## Phase 2 CLI version and local evidence

The workflow pin is **`@github/copilot@1.0.112`**. The planner supplied the actual
installed-version help captures:

- `docs/reference/copilot-cli-1.0.112-help.txt`
- `docs/reference/copilot-cli-1.0.112-permissions.txt`

Those files are the source of truth for the flags and permission rules. A local
attempt to inspect a newer CLI was blocked while extracting its cache; the
requested sandbox escalation was declined. No successful real Copilot CLI/model
execution is claimed for this implementation session. Local tests compare every
generated long flag to the supplied help and exercise the runner with a stub
executable. The stub verifies argv handling (no shell interpolation), output-file
handling, and removal of unrelated environment credentials.

CI and the thinking workflow install/use 1.0.112 and run `--no-auto-update
--version` and `--no-auto-update --help`; CI also runs `help permissions`. The
runner uses `--no-auto-update` so a cached newer binary cannot silently replace
the pinned version. It disables built-in MCPs, automatic custom instructions,
experimental features, and BASH_ENV; it does not trust repository hooks. The plan
prompt receives the default-branch AGENTS.md explicitly.

`buildCliArgs` passes the prompt contents as one `-p` argv entry with
`--no-ask-user`. Following the Phase 3 security review, its exact allow list is
now **`read`, `write`**, with a blanket **`--deny-tool shell`**. Built-in read tools
provide file discovery. There are no shell allows for find, git, or other commands.
This blocks `find -exec`, git pagers, `--ext-diff`, `--textconv`, and `-c` aliases
without relying on permission rules to understand their flags. The captured CLI
permissions reference says an unqualified shell deny matches all shell commands
and deny rules override allows. The explicit git push, gh, curl, wget, URL and
memory denies remain as well. As specified,
write is allowed in this disposable workspace; the prompt limits output to
`out/plan.md` or `out/answer.md`. These CLI permission rules and prompts are not
proof of model compliance; inspect the live output during the smoke test.

The runner starts the CLI without a shell, passes only ordinary runtime settings
and `COPILOT_GITHUB_TOKEN`, and uses `--secret-env-vars COPILOT_GITHUB_TOKEN` to
keep that credential out of CLI tool subprocesses. It rejects inherited
`APP_TOKEN`, `USER_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`. Model stdout/stderr are
not logged or executed. The artifact contains only generated Markdown; publisher
code always comes from the trusted routing-job artifact.

## Phase 2 workflow and state details

- Both entry workflows hold `ai-factory-issue-N` across routing, thinking, and
  publishing. The shared nested workflow has a distinct per-issue lock to avoid
  deadlocking against its caller. Timeouts are route 5, think 30, publish 5 minutes.
- The think job has `contents: read` plus the spec's explicit `issues: read`
  exception for prompt construction. Only `build-prompt` receives `GITHUB_TOKEN`;
  the Copilot step's YAML environment contains only `COPILOT_GITHUB_TOKEN`.
- The route job checks out trusted factory code with the App token, then uploads
  only `src/`, `package.json`, and `package-lock.json`. Think and publish download
  that source artifact independently. This replaces the spec's factory checkout
  inside think: a target repo's `GITHUB_TOKEN` cannot check out another private
  repo, and an App credential must not enter the thinking job. No `.git` directory,
  credentials or `node_modules` are included.
- Artifacts use stable run IDs with overwrite on full reruns, so rerunning only
  failed jobs can still find a successful earlier job's source/output. Publish
  runs after a thinking failure and posts the required failure comment when no
  valid output is available. Cancellation does not cause new publication.
- Replies have per-trigger source attributes: `comment-N` for `/ai`, and
  `issue-N-run-R` for automatic planning. A later command on the same issue is a
  new request. A failed answer/plan is updated in place when its retry succeeds.
- `FACTORY_APP_LOGIN` comes from the App-token action's slug, with `[bot]` appended.
  It defaults to `ai-factory[bot]` for local use. Only that App's comments can
  satisfy Phase 2 state markers or supply the approved plan. `/ai go` with a plan
  label but no stored App-authored plan gets the no-plan reply. Open questions
  do not prevent an explicit `/ai go`, as specified.
- Plans remove the opposite status label before adding `ai:plan-ready` or
  `ai:needs-info`. Missing/empty Open questions sections conservatively require
  information. An older successful publisher rerun cannot change a newer plan's
  labels. `/ai stop` only removes Copilot assignees; human assignees and PRs remain.
- Prompt inputs are fenced JSON with escaped backticks. Oldest comments are
  dropped first with a note; oversized remaining inputs are truncated, retaining
  framing. Prompts stay under 60,000 characters (and 120,000 UTF-8 bytes for argv).
  Publication strips factory markers, bounds text to below 50,000 characters and
  comments below 60 kB, rejects symlink/non-file or over-5-MB artifacts, and appends
  the genuine marker last. Existing output files are removed before thinking so
  checked-in/stale Markdown cannot masquerade as a fresh model response.

## Phase 2 GitHub smoke test (human)

1. Deploy the reviewed revision at the chosen factory ref and update the target
   caller template. Make `COPILOT_CLI_TOKEN` available to the target repo, with
   Copilot Requests permission only. Keep the App and assignment secrets from
   Phase 1. Confirm the organization `COPILOT_BOT_LOGIN` variable is available.
2. As an allowed human on an open issue, comment `/ai ask where is the HTTP
router configured?`. Expect one eyes reaction, route `mode=ask`, a read-only
   thinking job, and one answer with file/line citations (at most 400 words is a
   prompt requirement). Confirm no assignment was made.
3. Comment `/ai plan`. Inspect the resulting checklist (at most 12 items), Files,
   Risks and Open questions. Expect `ai:plan-ready` for None, otherwise
   `ai:needs-info`, and the `/ai go` instruction. Then comment `/ai go`: expect
   Copilot assigned using the latest App plan, `ai:in-progress`, and all plan
   status labels removed. Test a no-plan `/ai go` separately.
4. On an unassigned open issue, comment `/ai do add a /health endpoint`. Inspect
   assignment instructions for the requesting user, comment URL and instruction.
   Repeat with a new comment while Copilot is assigned: expect the already-working
   reply suggesting `@copilot` on the PR, without another assignment.
5. Comment `/ai stop`. Expect Copilot removed, `ai:manual` added and
   `ai:in-progress` removed. Verify any human assignee and open PR are preserved.
6. Add `ai:needs-plan` (or configured needs-plan label) to an otherwise eligible
   issue, and test `plan_gate: always` on a new issue. Expect the same shared
   planning/publishing flow, not the former Phase 1 placeholder. An unrelated
   added label must not start planning.
7. Check `/ai` and unknown verbs return help; noncommands, outside authors, bots,
   PR comments and closed issues cause no writes. `/ai plan` is the sole
   closed-issue exception. A completed request rerun must not duplicate replies,
   assignments or reactions; a new comment must be treated independently.
8. Force a model failure/missing output in a sandbox target. Expect one
   **Planning failed.** comment linking the run, and a failing publisher. Rerun
   failed jobs and then the entire run; verify successful retries reuse/update
   the same request state and do not duplicate comments.
9. Inspect permissions and environments: no write permission on think, no App or
   assignment token in think, no `GH_TOKEN`/`GITHUB_TOKEN` on the Copilot step,
   checkout credentials not persisted, only target default-branch code read,
   private factory code available via the trusted source artifact.

## Accepted Phase 2 interpretations

The planner accepted the private-factory source-artifact handoff, distinct nested
concurrency group, and conservative malformed/missing-plan handling after
reviewing commit `917c2ca`. The
specific `issues: read` prompt-building exception is followed despite the broader
“contents: read only” wording.

## Phase 3 local verification and design choices

Run the same local checks at the top of this document. New tests cover the exact
Copilot tool allow list, log tails/redaction, self-heal filters and identity split,
label-failure recovery, watchdog timestamps and linked PRs, cleanup after closure,
the 50-item cap, CLI dry-runs, and both workflows' checkout/token boundaries.
Transport tests use mocked fetch; command tests use the in-memory GitHub client.
No live Copilot session, GitHub write, or sandbox escape is part of local verification.

The Phase 3 verification uses Node.js 24.16.0 and actionlint 1.7.7. The default
`npm ci` cache under `~/.npm` was not writable in the sandbox; installation
succeeded with `npm ci --cache /private/tmp/ai-factory-npm-cache`. No changes to
the global cache or elevated commands were needed. The final lint, typecheck,
Vitest suite (25 files, 243 tests), and actionlint checks pass. Actionlint covers
all factory workflows and the target caller template. No runtime dependency was
added.

Self-heal accepts only failed/timed-out pull-request runs from the target repo.
It requires one matching open Copilot PR and the exact current head SHA, rechecking
the SHA after downloading logs. `COPILOT_BOT_LOGIN` identifies the user-token
comment author; `FACTORY_APP_LOGIN` identifies the App. Other commenters cannot
forge trusted repair receipts. Ambiguous branch matches are skipped.

The App reads at most three failed jobs' logs. Each retains at most 150 lines;
ANSI escapes and timestamps are removed. Lines matching `ghp_`, `github_pat_`,
`ghs_`, or key BEGIN headers are redacted; complete multi-line key blocks are also
redacted. The combined log excerpt stays within 20,000 characters and UTF-8 bytes.
HTML/factory marker and Markdown fence injection in logs is neutralized. Logs
are posted as data and are never executed or printed raw by the factory.

GitHub's [job-log endpoint](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run)
returns a short-lived signed download URL. The implementation reads the redirect
explicitly and downloads over HTTPS without forwarding the App authorization
header. It never logs the signed URL, including on download failure.

The repair request is posted with the **user client**, starting with a bold status
line and containing `@copilot`, the run link, instructions, log excerpt, and the
`self-heal run=… attempt=…` marker. **The comment is posted before rotating the
labels**, reversing spec steps 7–8: the durable receipt lets a rerun finish label
rotation without sending another repair or consuming an extra attempt. Existing
receipts also protect the counter if a different run arrives before labels recover.
Adding the new counter before removing older counters avoids a transient zero.
Only the App writes labels. At the configured limit, the App adds `ai:human-needed`
and posts one escalation for that PR; later failing runs do not repeat it.

Watchdog scans repository PR metadata and labeled issues with pagination, then
processes **at most 50 PR/issue candidates** in oldest-update order per run.
Metadata indexing and linked-record reads are not counted as processed candidates;
this preserves complete link knowledge when deciding that an issue has no open PR.
It scans all open Copilot PRs, including ready PRs, and resolves local timeline
cross-references without using GitHub Search. An open linked human PR also prevents
a false stale-issue alert. Cross-repository references are ignored.

For stale notices, the App adds the label before posting the comment. The comment's
timestamp then covers the factory's own label change; equal timestamps count as
already notified. Repeated schedule runs do not treat these writes as new user
activity. Later real activity can become stale again and receive a new notice.
A stale draft PR mentions the author of its first same-repo linked issue when
available; it does not invent an author when no issue link is present.

Closed/merged Copilot PRs cause watchdog to remove `ai:in-progress` and
`ai:awaiting-review` from their linked issues, including closed issues. Cleanup is
deferred when a replacement linked PR is still open. Automerge clears `ai:stale`
on an eligible ready PR. The stale label on linked issues is not removed by
automerge: that additional issue write is not specified and would require broader
permissions for the automerge workflow.

`reusable-self-heal.yml` has a 10-minute timeout and per-head-branch concurrency;
`reusable-watchdog.yml` has a 15-minute timeout and repository-wide concurrency.
Both check out only `inputs.factory_repo` at `inputs.factory_ref`, never the
target repo or PR code. Their App token includes contents read for the trusted
factory checkout and default-branch config reads. Workflow-token job permissions
match the Phase 3 table; watchdog receives no user or Copilot CLI token.

## Phase 3 GitHub smoke test (human)

1. Deploy the reviewed revision to the configured factory ref and update the
   caller YAML. Replace `workflow_run.workflows: [CI]` with the actual workflow
   names. The caller enables the half-hour schedule and manual watchdog dispatch.
   Verify the App has Actions read, Issues write, Pull requests write, and Contents
   read, and both identity variables are available where required.
2. On a same-repo Copilot PR in a sandbox target, introduce a failing CI test.
   Confirm self-heal reads only that run's logs, posts the `@copilot` request as
   the licensed **bot user**, and uses the App to set `ai:fix-1`. Verify the log
   excerpt and run link. Confirm Copilot actually pushes a fix and CI runs again.
3. Rerun the self-heal workflow for the same failed run: expect no second repair
   request and no extra attempt. Trigger a newer push before an older run completes:
   the older run must be skipped by SHA. Fork runs, non-PR runs, successful runs,
   and human-authored PRs must produce no writes.
4. Let a sandbox PR reach `max_fix_attempts` (or temporarily set the limit to zero).
   Expect `ai:human-needed`, one App-authored escalation mentioning `escalate_to`,
   and no further user-authored repair requests. Verify later failures do not spam
   escalation comments. Test label-write failure/retry if feasible.
5. Leave a draft Copilot PR inactive beyond `stale_hours` (use a short supported
   threshold for the sandbox). Run watchdog manually. Expect `ai:stale` and one
   notice mentioning the linked issue author. Repeat immediately and after another
   stale interval without activity: no repeated notice. New activity followed by
   another stale interval should permit a new notice.
6. Test an assigned in-progress issue without a PR, then issues with a ready PR and
   a timeline-only PR link. Only the first should get an orphaned-issue notice.
   Close/merge a linked Copilot PR and verify issue-label cleanup. Keep a replacement
   PR open to verify active work is preserved.
7. Mark a stale Copilot PR ready and confirm automerge removes its stale label.
   Review watchdog's summary table and 50-item cap. Inspect both workflow checkouts
   and environments to confirm no PR code execution and the intended identity split.

## Phase 3 planner questions

Confirm the comment-before-counter repair ordering, label-before-notice watchdog
ordering, one escalation per exhausted PR, and cleanup deferral while another
linked PR is open. Confirm that automerge's stale-label removal should remain
PR-only. No Phase 4 requirements engine is implemented.
