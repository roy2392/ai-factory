# Task: one-click GitHub App creation (manifest flow)

GitHub Apps can only be created by a logged-in user in a browser. The
[manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
reduces that to one click. Build `scripts/create-github-app.ts`, run with
`npm run create-app -- --owner roy2392 --repos ai-factory,ai-factory-showcase --secrets-repo roy2392/ai-factory-showcase`.

## Behaviour
1. Start an HTTP server on `127.0.0.1` with a random free port. Generate a random `state` (32 bytes, hex).
2. `GET /` serves an HTML page with a form that POSTs to `https://github.com/settings/apps/new?state=<state>`,
   with a hidden `manifest` field holding this JSON:
   - `name`: `ai-factory-<owner>` (flag `--name` overrides it; App names are global)
   - `url`: `https://github.com/<owner>/ai-factory`
   - `hook_attributes`: `{ "url": "https://example.invalid", "active": false }`
   - `redirect_url`: `http://127.0.0.1:<port>/callback`
   - `public`: false
   - `default_permissions`: `contents: read`, `issues: write`, `pull_requests: write`, `actions: read`, `metadata: read`
   - `default_events`: `[]`
   The page shows one button, "Create GitHub App on github.com", plus a short explanation. The script opens the
   page with `open` (macOS) / `xdg-open`, and prints the URL as a fallback.
3. `GET /callback?code=…&state=…`: reject a state mismatch (HTTP 400, keep waiting). Exchange the code with
   `POST https://api.github.com/app-manifests/{code}/conversions` (no auth header needed). The code
   expires after 1 hour and can be used once.
4. From the response, keep `id`, `slug`, `pem`, `html_url`. **Never print or log `pem`, `client_secret` or
   `webhook_secret`.**
5. Write the key to `~/.config/ai-factory/<slug>.pem`, creating the directory with mode `0700` and the file
   with mode `0600`. Refuse to overwrite an existing file unless `--force` is given.
6. Store the secrets by spawning `gh secret set NAME -R <secrets-repo>` with the value on **stdin**,
   never in argv: `FACTORY_APP_ID` = id and `FACTORY_APP_PRIVATE_KEY` = pem. If `gh` fails, say so and print
   the manual command, which reads from the key file and never echoes the value.
7. Print: App id, slug, settings URL, the key file path, and the install URL
   `https://github.com/apps/<slug>/installations/new`, with "Install it on: <repos>". Respond to the browser with
   a success page that has the same install link. Shut down the server and exit 0.
8. Time out after 15 minutes with exit 1.

## Code and tests
- Pure helpers in `src/app-manifest.ts`: `buildManifest(opts)`, `renderFormPage(manifest, state)` (HTML-escape
  the JSON inside the attribute), `validateCallback(query, expectedState)`, `summarize(conversion)` (output
  must not contain pem or secrets).
- `test/app-manifest.test.ts`: manifest fields and permissions; the escaping; state mismatch; `summarize`
  never includes the pem, client secret or webhook secret.
- Add `"create-app"` to the package.json scripts. Document the flow in a short section of `docs/SETUP.md` §3
  ("Fast path"), keeping the manual steps as the fallback.
- No new runtime dependencies (use `node:http`, `node:crypto`, `node:child_process`, `fetch`).

## Not in scope
Running the script: Claude runs it, and the user clicks in the browser. Installing the App (the user clicks
the printed link).
