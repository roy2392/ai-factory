import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
  buildManifest,
  escapeHtml,
  renderFormPage,
  summarize,
  validateCallback,
} from '../src/app-manifest.js';

const slugPattern = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;
const conversionSchema = z.object({
  id: z.number().int().positive(),
  slug: z.string().regex(slugPattern),
  pem: z.string().min(1),
  html_url: z.url().startsWith('https://github.com/'),
});

export async function saveKey(
  home: string,
  slug: string,
  pem: string,
  force: boolean,
): Promise<string> {
  if (!slugPattern.test(slug)) throw new Error('Invalid App slug');
  const directory = join(home, '.config', 'ai-factory');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error('Invalid key directory');
  await chmod(directory, 0o700);
  const path = join(directory, `${slug}.pem`);
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_NOFOLLOW |
    (force ? 0 : constants.O_EXCL);
  const file = await open(path, flags, 0o600);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Invalid key file');
    // Restrict an existing file before replacing its contents, even with --force.
    await file.chmod(0o600);
    await file.truncate(0);
    await file.writeFile(pem, 'utf8');
  } finally {
    await file.close();
  }
  return path;
}

function runProcess(
  command: string,
  args: string[],
  input: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // Never inherit stdout/stderr: gh or a failing subprocess could echo secrets.
    const child = spawn(command, args, {
      shell: false,
      stdio: ['pipe', 'ignore', 'ignore'],
      signal,
    });
    child.once('error', () => resolve(false));
    child.once('close', (code) => resolve(code === 0));
    child.stdin.on('error', () => {
      child.kill();
      resolve(false);
    });
    child.stdin.end(input);
  }).catch(() => false);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function runCreateApp(
  argv: string[],
  options: { homeDir?: string; log?: (message: string) => void } = {},
): Promise<number> {
  const log = options.log ?? console.log;
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        owner: { type: 'string' },
        repos: { type: 'string' },
        'secrets-repo': { type: 'string' },
        name: { type: 'string' },
        force: { type: 'boolean', default: false },
      },
    }));
    if (
      !values.owner ||
      !slugPattern.test(values.owner) ||
      !values.repos ||
      !/^[\w.-]+(?:,[\w.-]+)*$/.test(values.repos) ||
      !values['secrets-repo'] ||
      !/^[\w-]+\/[\w.-]+$/.test(values['secrets-repo']) ||
      (values.name !== undefined && !values.name.trim())
    )
      throw new Error('Invalid flags');
  } catch {
    log(
      'Usage: npm run create-app -- --owner OWNER --repos REPO,REPO --secrets-repo OWNER/REPO [--name NAME] [--force]',
    );
    return 1;
  }
  const owner = values.owner,
    repos = values.repos,
    secretsRepo = values['secrets-repo'];
  const name = values.name,
    force = values.force;
  const state = randomBytes(32).toString('hex');
  const controller = new AbortController();
  return new Promise<number>((resolveResult) => {
    let baseUrl = '',
      processing = false,
      finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      controller.abort();
      server.close(() => resolveResult(code));
      if (code !== 0) server.closeAllConnections();
    };
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      const reply = (status: number, body: string) => {
        response.writeHead(status);
        response.end(body);
      };
      try {
        const url = new URL(request.url ?? '/', baseUrl);
        if (request.method !== 'GET') {
          reply(405, 'Method not allowed');
          return;
        }
        if (url.pathname === '/') {
          reply(
            200,
            renderFormPage(
              buildManifest({
                owner,
                name,
                port: Number(new URL(baseUrl).port),
              }),
              state,
            ),
          );
          return;
        }
        if (url.pathname !== '/callback') {
          reply(404, 'Not found');
          return;
        }
        const code = validateCallback(url.searchParams, state);
        if (!code) {
          reply(
            400,
            'Invalid callback state or code. Return to the setup page and try again.',
          );
          return;
        }
        if (processing || finished) {
          reply(409, 'Callback already received');
          return;
        }
        processing = true;
        // GitHub manifest conversion: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
        const result = await fetch(
          `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
          {
            method: 'POST',
            headers: { Accept: 'application/vnd.github+json' },
            redirect: 'error',
            signal: controller.signal,
          },
        );
        if (!result.ok) throw new Error('Conversion failed');
        // zod strips client_secret/webhook_secret. Never log bodies or caught errors.
        const conversion = conversionSchema.parse(await result.json());
        if (finished) return;
        const summary = summarize(conversion);
        const keyPath = await saveKey(
          options.homeDir ?? homedir(),
          summary.slug,
          conversion.pem,
          force,
        );
        if (finished) return;
        let secretsStored = true;
        for (const [secret, value, manualInput] of [
          [
            'FACTORY_APP_ID',
            String(summary.id),
            `printf '%s' ${shellQuote(String(summary.id))} | `,
          ],
          ['FACTORY_APP_PRIVATE_KEY', conversion.pem, ''],
        ] as const) {
          const args = ['secret', 'set', secret, '-R', secretsRepo];
          if (!(await runProcess('gh', args, value, controller.signal))) {
            if (finished) return;
            secretsStored = false;
            log(
              `gh failed to store ${secret}. Run manually:\n${manualInput}gh secret set ${secret} -R ${shellQuote(secretsRepo)}${secret === 'FACTORY_APP_PRIVATE_KEY' ? ` < ${shellQuote(keyPath)}` : ''}`,
            );
          }
        }
        if (finished) return;
        log(
          `App id: ${summary.id}\nSlug: ${summary.slug}\nApp URL: ${summary.html_url}\nSettings URL: ${summary.settings_url}\nKey file: ${keyPath}\nInstall URL: ${summary.install_url}\nInstall it on: ${repos}`,
        );
        reply(
          200,
          `<!doctype html><html lang="en"><meta charset="utf-8"><title>App created</title><h1>GitHub App created</h1><p>${secretsStored ? 'Key saved and repository secrets stored.' : 'Key saved. Repository secret setup needs attention; see the terminal for manual commands.'}</p><a href="${escapeHtml(summary.install_url)}">Install GitHub App</a><p>Install it on: ${escapeHtml(repos)}</p></html>`,
        );
        finish(0);
      } catch {
        if (finished) return;
        log(
          'App setup failed. No credential details were logged. Check GitHub App settings and the local key directory before retrying; existing keys require --force.',
        );
        reply(500, 'App setup failed. See the terminal for next steps.');
        finish(1);
      }
    });
    const timer = setTimeout(
      () => {
        log('App setup timed out after 15 minutes.');
        finish(1);
      },
      15 * 60 * 1000,
    );
    server.once('error', () => {
      log('Could not start the local callback server.');
      finish(1);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        finish(1);
        return;
      }
      baseUrl = `http://127.0.0.1:${address.port}`;
      log(`Open this URL to create the App: ${baseUrl}`);
      void runProcess(
        process.platform === 'darwin' ? 'open' : 'xdg-open',
        [baseUrl],
        undefined,
        controller.signal,
      ).then((opened) => {
        if (!opened && !finished)
          log('Browser could not be opened. Use the URL above.');
      });
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  // The entrypoint is never invoked by tests. Only mocked orchestration is exercised.
  runCreateApp(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error('App setup failed. No credential details were logged.');
      process.exitCode = 1;
    });
}
