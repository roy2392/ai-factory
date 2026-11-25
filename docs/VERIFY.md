# Phase 1 verification

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
   needs-plan issue gets only **Plan gate:** waiting for phase 2, once. A human
   PR, fork PR or PR to a different base branch receives no automerge writes.
9. Inspect run logs: no tokens or full webhook payloads, and factory checkout
   only in `pull_request_target`. The automerge job has no user token.

`/ai` commands, actual planning, self-heal, watchdog, and requirements execution
are later phases and are not part of this smoke test.

## Spec interpretations and planner questions

- The marker spec says to escape `>` as `>` while also forbidding `-->` in JSON.
  This implementation uses the JSON escape `\u003e` and restores the original
  text on parse. Confirm that intended spelling.
- The config spec has no bot-user login. `COPILOT_BOT_LOGIN` is the minimal
  non-secret addition used to honor “never request the bot user” without giving
  automerge the assignment token. Confirm this identity mechanism.
- A single installation token is scoped to one owner; cross-owner targets fail
  explicitly before checkout. Confirm whether cross-owner support is needed in
  a future phase.
- Linked issue references are parsed and reported, without mutating the issue:
  Phase 1 specifies no linked-issue write. Confirm this is the intended scope.
- Within automerge step 3, reviewers are requested before adding
  `ai:awaiting-review`. The label marks completed review setup, preventing reruns
  from requesting already-completed reviews after GitHub clears the pending
  lists. To intentionally apply a changed reviewer configuration, remove that
  label and rerun. Confirm this interpretation of reviewer idempotency.
- Reusable commands run inside `.factory` as `npx --no-install tsx src/cli.ts`
  so they use the installed factory dependencies. This is equivalent to the
  specified path from the workspace root without resolving a fresh `tsx` there.

Local verification does not establish Copilot entitlement, PAT/App permissions,
private workflow access, review policies, or a successful live issue-to-merge run.
