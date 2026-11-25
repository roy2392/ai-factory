# Phase 1: foundation and core loop

Read first: `AGENTS.md`, `docs/ARCHITECTURE.md` (§3.1, §3.5, §4, §5), `docs/CONFIG.md`.

**Goal:** a new issue in a target repo is assigned to the Copilot coding agent, and the PR that Copilot
opens gets auto-merge, labels and reviewers when it becomes ready.

## 1. Project scaffold
- `package.json` (`"type": "module"`, `"engines": {"node": ">=24"}`), scripts: `lint`, `format`,
  `typecheck` (`tsc --noEmit`), `test` (`vitest run`), `factory` (`tsx src/cli.ts`).
- `tsconfig.json` strict, `noUncheckedIndexedAccess: true`, `module`/`moduleResolution: nodenext`.
- ESLint flat config + Prettier. `.gitignore`, `.nvmrc` (24), `LICENSE` (MIT).
- `.github/workflows/ci.yml` for this repo: on push and PR → `npm ci`, lint, typecheck, test, actionlint
  (use `rhysd/actionlint` via its download script or the docker image, pinned).

## 2. Shared modules

### `src/labels.ts`
One exported list `LABELS` of `{ name, color, description }` with:
`ai:manual`, `ai:needs-plan`, `ai:plan-ready`, `ai:needs-info`, `ai:in-progress`, `ai:awaiting-review`,
`ai:stale`, `ai:human-needed`, `ai:fix-1` … `ai:fix-10`, `requirements`.
Export helpers `fixAttemptOf(labels: string[]): number` (highest `ai:fix-N`, 0 if none).

### `src/markers.ts`
- `marker(kind: string, attrs?: Record<string,string>, json?: unknown): string` →
  `<!-- ai-factory:<kind> k=v k=v {json} -->`. Attribute values must match `^[A-Za-z0-9._/-]+$`
  (throw otherwise). JSON must not contain `-->` (escape `>` as `>`).
- `findMarkers(body: string, kind: string)` → `{ attrs, json }[]`. Tolerant of whitespace; ignores
  malformed markers.
- Kinds used in this project: `dispatch`, `plan`, `answer`, `self-heal`, `stale`, `task`, `req-state`, `review`.

### `src/config.ts`
- `loadConfig(client, repo, ref)` reads `.github/ai-factory.yml` through the client (404 → defaults).
- zod schema exactly as `docs/CONFIG.md`; `.strict()` so unknown keys fail; errors list the key paths.
- `base_branch` default = repo default branch (passed in).
- Export `DEFAULT_CONFIG` and `type FactoryConfig`.

### `src/context.ts`
- `readEvent()` → parse `GITHUB_EVENT_PATH`, `GITHUB_EVENT_NAME`, `GITHUB_REPOSITORY`. Typed unions for
  the events used: `issues`, `issue_comment`, `pull_request_target`, `workflow_run`, `schedule`,
  `workflow_dispatch`. Unknown event → throw with a clear message.
- Event payloads in `test/fixtures/*.json` modelled on real GitHub payloads (trimmed).

### `src/github/`
- `client.ts`: `interface GitHubClient` with only the methods the phases need (add them as you go):
  `getIssue`, `listIssueComments`, `createComment`, `updateComment`, `addLabels`, `removeLabel`,
  `ensureLabels`, `getFile`, `getRepo`, `getPullRequest`, `listPullRequestsForBranch`,
  `enablePullRequestAutoMerge` (GraphQL `enablePullRequestAutoMerge`, needs the PR node id),
  `requestReviewers`, `addReaction`.
- `octokit.ts`: implementation with retry + throttling plugins. Base URL from `GITHUB_API_URL`.
- `fake.ts`: in-memory implementation for tests that records every write call.

### `src/copilot.ts`
- `COPILOT_LOGINS = new Set(["Copilot", "copilot-swe-agent", "copilot-swe-agent[bot]"])`;
  `isCopilot(login)`.
- `assignToCopilot(client, { repo, issue, baseBranch, customAgent?, model?, instructions })`:
  `POST /repos/{o}/{r}/issues/{n}/assignees` with
  `{ assignees: ["copilot-swe-agent[bot]"], agent_assignment: { target_repo, base_branch, custom_instructions, custom_agent, model } }`.
  Omit empty optional fields. This call **must** use the client built from `COPILOT_ASSIGN_TOKEN`
  (a second `GitHubClient` instance, the "user client").
- `buildInstructions({ issueUrl, extra? })` → markdown: link to the issue, "Follow AGENTS.md", "Run the
  build and tests before finishing and report the result honestly in the PR description", plus `extra`.
  Cap at 8 000 characters (truncate `extra` first, with a note).

### `src/filters.ts` (pure)
- `shouldDispatch(issue, config)` → `{ ok: true } | { ok: false, reason }`. Reasons, in this order:
  `closed`, `pull-request`, `bot-author`, `association`, `skip-label:<name>`, `already-assigned`,
  `task-issue` (body has a `task` marker).
- `planGateApplies(issue, config)` → `config.plan_gate === "always" || (plan_gate === "label" && has needs_plan label)`.

### `src/cli.ts`
`factory <command>` with `dispatch`, `automerge`, `labels`. Each command module exports
`run(deps)` where `deps = { event, appClient, userClient, config, log }`. Flags: `--dry-run` (log the
writes, do not perform them; implement by wrapping the client), `--repo OWNER/REPO` for `labels`.
Exit codes: 0 ok or intentionally skipped, 1 error. Skips log the reason as a `::notice::`.

## 3. Commands

### `dispatch`
Triggers: `issues.opened`, and `issues.labeled` when the label is `ai:needs-plan` (no-op in phase 1,
see below).
1. `shouldDispatch`; on skip → notice and exit 0.
2. If `planGateApplies` → in phase 1 only add a comment "**Plan gate:** waiting for phase 2" with marker
   `dispatch state=gated` (idempotent) and exit. Phase 2 replaces this.
3. Else: `assignToCopilot` (user client), add `ai:in-progress` (app client), comment
   "**Assigned to Copilot.** Follow progress in the linked pull request." with marker
   `dispatch state=assigned`. Do not comment twice (check the marker first).

### `automerge`
Trigger: `pull_request_target` types `opened`, `ready_for_review`, `reopened`.
1. Skip unless: author is Copilot, head repo = base repo, PR not draft, base branch = config base branch.
2. Enable auto-merge with `config.merge_method` (if it is already on, do nothing).
3. Add `ai:awaiting-review`; request `config.reviewers` (users vs `org/team` split); never request the
   bot user.
4. Linked issue: parse `Fixes #N` / `Closes #N` / `Resolves #N` from the PR body (case-insensitive, same
   repo only). No error if there is none.

### `labels`
`factory labels --repo OWNER/REPO` creates or updates all `LABELS` (by name; update color/description
if they differ). Uses the app client. Prints a table of created / updated / unchanged.

## 4. Reusable workflows
Each workflow: `on: workflow_call` with inputs `factory_repo` (string, required) and `factory_ref`
(string, default `v1`), secrets `FACTORY_APP_ID`, `FACTORY_APP_PRIVATE_KEY`, `COPILOT_ASSIGN_TOKEN`.
Common steps:
1. `actions/create-github-app-token` (scoped to the target repo + the factory repo).
2. Checkout the factory repo at `factory_ref` into `./.factory` with the App token,
   `persist-credentials: false`. **Never check out the target repo's PR code.**
3. `actions/setup-node` (24, npm cache keyed on `.factory/package-lock.json`), `npm ci` in `.factory`.
4. Run `npx tsx .factory/src/cli.ts <command>` with env `APP_TOKEN`, `USER_TOKEN` (only where needed).

| File | Job permissions | Concurrency group |
|---|---|---|
| `reusable-dispatch.yml` | `contents: read`, `issues: write` | `ai-factory-issue-${{ github.event.issue.number }}` |
| `reusable-automerge.yml` | `contents: read`, `pull-requests: write` | `ai-factory-pr-${{ github.event.pull_request.number }}` |

`timeout-minutes: 10` for both.

## 5. Templates (target repo)
- `templates/target-repo/.github/workflows/ai-factory.yml`: the thin caller. Triggers: `issues`
  (`opened`, `labeled`), `pull_request_target` (`opened`, `ready_for_review`, `reopened`). Two jobs that
  call the reusable workflows with `uses: OWNER/ai-factory/.github/workflows/reusable-….yml@v1`,
  `secrets: inherit`, and `if:` on `github.event_name`. Leave `OWNER` as a placeholder.
  Add `permissions: {}` at the top, and grant per job what the reusable workflow needs.
- `templates/target-repo/.github/workflows/copilot-setup-steps.yml`: job **must** be named
  `copilot-setup-steps`; `on: workflow_dispatch` + `push`/`pull_request` limited to this file's path;
  `permissions: contents: read`; checkout, setup-java 25 (temurin) with maven cache, `mvn -B -q -DskipTests dependency:go-offline`.
  Commented-out blocks for Node and Python.
- `templates/target-repo/.github/ai-factory.yml` with the defaults (all keys, commented).

## 6. Tests (must exist)
- `test/markers.test.ts`: round trip, malformed markers ignored, `-->` in JSON, bad attribute value throws.
- `test/config.test.ts`: missing file → defaults; partial file merges; unknown key fails with its path;
  each validation range in `docs/CONFIG.md`.
- `test/filters.test.ts`: one case per skip reason, in priority order; plan gate for each mode.
- `test/copilot.test.ts`: request body shape (empty fields omitted); instruction cap and truncation.
- `test/commands/dispatch.test.ts` (fake client + fixtures): assigned path writes exactly assign + label +
  comment; rerun is idempotent; gated path; each skip writes nothing.
- `test/commands/automerge.test.ts`: non-Copilot author skipped; draft skipped; fork skipped;
  enables auto-merge once; team/user reviewer split; linked issue parsing.
- `test/commands/labels.test.ts`: create / update / unchanged.

## 7. Acceptance criteria
- [ ] `npm run lint && npm run typecheck && npm test` pass; `actionlint` passes on every workflow and template.
- [ ] No workflow job has a token or permission it does not use (review the table in §4).
- [ ] `--dry-run` on `dispatch` with `test/fixtures/issues.opened.json` prints the planned writes and performs none.
- [ ] `docs/VERIFY.md` created with the manual GitHub smoke test for this phase (from `docs/SETUP.md` §5 steps 1–2).
