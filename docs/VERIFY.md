# Factory verification: Phases 1 and 2

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

Self-heal, watchdog, and requirements execution are later phases. The Phase 2
command and planning checks are below.

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
  Phase 1 specifies no linked-issue write. Phase 3 adds removing `ai:stale` in
  automerge; that is not implemented in Phase 2.
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
`--no-ask-user`. It allows read/write tools and the specified shell exploration
commands, limiting git to read-oriented subcommands rather than `git:*`. It
explicitly denies git push, gh, curl, wget, URL tools and memory. As specified,
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

## Phase 2 planner questions

Confirm the private-factory source-artifact handoff, distinct nested concurrency
group, and conservative malformed/missing-plan handling described above. The
specific `issues: read` prompt-building exception is followed despite the broader
“contents: read only” wording. No Phase 3 or requirements execution is included.
