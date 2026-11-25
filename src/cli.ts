import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { readEvent, type FactoryEvent } from './context.js';
import { repoParts, type GitHubClient } from './github/client.js';
import { dryRunClient } from './github/dry-run.js';
import { OctokitGitHubClient } from './github/octokit.js';
import * as dispatch from './commands/dispatch.js';
import * as automerge from './commands/automerge.js';
import * as labels from './commands/labels.js';

function escapeAnnotation(value: string): string {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export async function main(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  output: (message: string) => void = console.log,
  createClient: (token: string, baseUrl?: string) => GitHubClient = (
    token,
    url,
  ) => new OctokitGitHubClient(token, url),
): Promise<number> {
  const secrets = [env.APP_TOKEN, env.USER_TOKEN].filter(
    (v): v is string => !!v,
  );
  const log = (message: string) => {
    for (const secret of secrets)
      message = message.split(secret).join('[REDACTED]');
    output(message);
  };
  // Mask derived encodings too, without ever emitting credentials in ordinary logs.
  if (env.GITHUB_ACTIONS === 'true')
    for (const secret of secrets) {
      output(`::add-mask::${escapeAnnotation(secret)}`);
      output(
        `::add-mask::${escapeAnnotation(Buffer.from(secret).toString('base64'))}`,
      );
    }
  try {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        'dry-run': { type: 'boolean', default: false },
        repo: { type: 'string' },
      },
    });
    const command = positionals[0];
    if (
      positionals.length !== 1 ||
      !['dispatch', 'automerge', 'labels'].includes(command ?? '')
    )
      throw new Error(
        'Usage: factory dispatch|automerge|labels [--dry-run] [--repo OWNER/REPO (labels only)]',
      );
    if (values.repo && command !== 'labels')
      throw new Error('--repo is only supported for labels');
    let event: FactoryEvent;
    if (command === 'labels') {
      const repo = values.repo ?? '';
      repoParts(repo);
      event = { name: 'workflow_dispatch', repo, inputs: {} };
    } else event = readEvent(env);
    if (!values['dry-run'] && !env.APP_TOKEN)
      throw new Error('APP_TOKEN is required');
    if (!values['dry-run'] && command === 'dispatch' && !env.USER_TOKEN)
      throw new Error(
        'USER_TOKEN (COPILOT_ASSIGN_TOKEN) is required for dispatch',
      );
    let appClient = createClient(env.APP_TOKEN ?? '', env.GITHUB_API_URL);
    // Automerge and labels never instantiate a user-token client.
    let userClient =
      command === 'dispatch'
        ? createClient(env.USER_TOKEN ?? '', env.GITHUB_API_URL)
        : appClient;
    if (values['dry-run']) {
      appClient = dryRunClient(appClient, log);
      userClient = dryRunClient(userClient, log);
    }
    const repo = await appClient.getRepo(event.repo);
    // Configuration is trusted default-branch data, never content from the PR head.
    const config = await loadConfig(appClient, repo, repo.default_branch);
    const commands = { dispatch, automerge, labels };
    await commands[command as keyof typeof commands].run({
      event,
      appClient,
      userClient,
      config,
      log,
    });
    return 0;
  } catch (error) {
    let message = 'Unexpected factory error';
    if (error instanceof z.ZodError) message = 'Invalid GitHub event payload';
    else if (typeof error === 'object' && error !== null && 'status' in error)
      message = `GitHub API request failed (status ${String(error.status)})`;
    else if (error instanceof Error) message = error.message;
    log(`::error::${escapeAnnotation(message)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
