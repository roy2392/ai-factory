# One-time setup (manual)

These steps are done by a human in the GitHub UI. The code cannot do them.

## 1. Copilot
1. Org settings → Copilot → Policies: turn on the **Copilot coding agent** (cloud agent) and
   **Copilot code review** for the target repositories.
2. Create a bot **user** account (for example `ai-factory-bot`), add it to the org with write access to the
   target repos, and give it a Copilot Business/Enterprise seat. Its sessions and premium requests are
   billed to this seat.

## 2. Tokens of the bot user
Create two fine-grained PATs on the bot user, scoped to the target repositories:

| Secret | Permissions |
|---|---|
| `COPILOT_ASSIGN_TOKEN` | Metadata: read · Actions, Contents, Issues, Pull requests: read and write |
| `COPILOT_CLI_TOKEN` | Copilot Requests (account permission). No repository permissions. |

Set an expiry and a calendar reminder to rotate them.

Also set an organization **variable** (not a secret) `COPILOT_BOT_LOGIN` = the bot user's login. Automerge
uses it so the bot is never requested as a reviewer of its own PRs.

## 3. GitHub App
### Fast path

With Node.js 24, dependencies installed (`npm ci`), and GitHub CLI authenticated
(`gh auth login`) with access to manage the target repository's secrets, run:

```sh
npm run create-app -- --owner roy2392 --repos ai-factory,ai-factory-showcase --secrets-repo roy2392/ai-factory-showcase
```

The script opens a local page; click **Create GitHub App on github.com** and confirm
in GitHub within 15 minutes. Sign in as the intended App owner: this flow creates
a personal-account App. `--owner` supplies the name/homepage, not an ownership
transfer. Use `--name NAME` if the default `ai-factory-OWNER` name is already taken.
The callback saves `~/.config/ai-factory/<slug>.pem` with mode `0600` inside a `0700`
directory, then sends the App ID and key to `gh secret set` through stdin. Existing
keys are preserved unless `--force` is given. If `gh` fails, follow the printed
manual commands; they read the key file without displaying it.

Click the printed installation link and select both the factory and target repos.
`--repos` is an installation reminder; `--secrets-repo` receives the two repository
secrets. For organization secrets or organization-owned Apps, use the manual steps
below. The script never prints the private key, client secret, or webhook secret.

### Manual fallback

Create the App `ai-factory` (no webhook needed: workflows are triggered by Actions events).

- Repository permissions: Contents **read**, Issues **read and write**, Pull requests **read and write**,
  Actions **read** (logs for self-heal), Metadata **read**.
- Install it on the target repositories.
- Store `FACTORY_APP_ID` and `FACTORY_APP_PRIVATE_KEY` as **organization secrets**, available to the
  target repositories.
- The factory repo and the target repos must have the **same owner** (one installation token covers both).
- Also install it on the **ai-factory** repository itself: reusable workflows use the App token to check
  out the factory code when the factory repo is private.

## 4. Target repository settings
1. Settings → General: turn on **Allow auto-merge**; turn on "Automatically delete head branches".
2. Ruleset on the default branch:
   - require a pull request with **1 approval**, dismiss stale approvals;
   - require status checks (your CI);
   - require conversation resolution;
   - **automatically request Copilot code review**.
3. Settings → Actions: decide how workflows on Copilot PRs run. By default a human has to click
   "Approve and run". If required checks must run without that click, change the Copilot coding agent
   setting for workflow approval. Check the current docs, since this setting has changed over time.
4. Settings → Copilot → Coding agent: keep the firewall on; add only the hosts the build needs
   (for example Maven Central).
5. Create the labels: run `npx ai-factory labels --repo OWNER/REPO` (Phase 1 deliverable), or create
   them by hand from `src/labels.ts`.
6. Copy `templates/target-repo/` into the repo and adjust `AGENTS.md` and `copilot-setup-steps.yml`.

## 5. Smoke test
1. Open an issue "Add a /health endpoint that returns 200 OK" → Copilot is assigned within a minute.
2. Copilot opens a draft PR → when it is ready, auto-merge is enabled and a review is requested.
3. Comment `/ai ask where is the HTTP router configured?` on any issue → you get an answer comment.
