import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import { DEFAULT_CONFIG, loadConfig } from './config.js';
import { readEvent, type FactoryEvent } from './context.js';
import { repoParts, type GitHubClient } from './github/client.js';
import { dryRunClient } from './github/dry-run.js';
import { OctokitGitHubClient } from './github/octokit.js';
import * as dispatch from './commands/dispatch.js';
import * as automerge from './commands/automerge.js';
import * as labels from './commands/labels.js';
import * as aiCommand from './commands/ai-command.js';
import * as buildPrompt from './commands/build-prompt.js';
import * as post from './commands/post.js';
import { parseMode } from './copilot-cli.js';
import * as selfHeal from './commands/self-heal.js';
import * as watchdog from './commands/watchdog.js';
import * as requirements from './commands/requirements.js';

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
  const secrets = [env.APP_TOKEN, env.USER_TOKEN, env.GITHUB_TOKEN].filter(
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
        mode: { type: 'string' },
        'output-dir': { type: 'string' },
        'input-dir': { type: 'string' },
        issue: { type: 'string' },
      },
    });
    const command = positionals[0];
    if (
      positionals.length !== 1 ||
      ![
        'dispatch',
        'automerge',
        'labels',
        'ai-command',
        'build-prompt',
        'post-plan',
        'post-answer',
        'self-heal',
        'watchdog',
        'requirements',
        'requirements-apply',
      ].includes(command ?? '')
    )
      throw new Error(
        'Usage: factory dispatch|automerge|labels|ai-command|build-prompt|post-plan|post-answer|self-heal|watchdog|requirements|requirements-apply [--dry-run] [--repo OWNER/REPO (labels only)] [--mode ask|plan (build-prompt only)] [--issue N (requirements scan)] [--input-dir PATH (requirements-apply)] [--output-dir PATH]',
      );
    if (values.repo && command !== 'labels')
      throw new Error('--repo is only supported for labels');
    if (values['input-dir'] && command !== 'requirements-apply')
      throw new Error('--input-dir is only supported for requirements-apply');
    if (values.issue && command !== 'requirements')
      throw new Error('--issue is only supported for requirements');
    const requestedIssue =
      values.issue === undefined ? undefined : Number(values.issue);
    if (
      requestedIssue !== undefined &&
      (!Number.isSafeInteger(requestedIssue) || requestedIssue <= 0)
    )
      throw new Error('--issue must be a positive integer');
    if (command === 'requirements-apply' && values['dry-run'])
      throw new Error(
        'Use requirements --dry-run to inspect the plan; apply dry-run is not supported',
      );
    if (values.mode && command !== 'build-prompt')
      throw new Error('--mode is only supported for build-prompt');
    if (
      values['output-dir'] &&
      ![
        'build-prompt',
        'post-plan',
        'post-answer',
        'requirements',
        'requirements-apply',
      ].includes(command!)
    )
      throw new Error(
        '--output-dir is only supported for prompt/post commands',
      );
    let event: FactoryEvent;
    if (command === 'labels') {
      const repo = values.repo ?? '';
      repoParts(repo);
      event = { name: 'workflow_dispatch', repo, inputs: {} };
    } else event = readEvent(env);
    const token = command === 'build-prompt' ? env.GITHUB_TOKEN : env.APP_TOKEN;
    if (!values['dry-run'] && !token)
      throw new Error(
        command === 'build-prompt'
          ? 'GITHUB_TOKEN is required for build-prompt'
          : 'APP_TOKEN is required',
      );
    const needsUser = [
      'dispatch',
      'ai-command',
      'self-heal',
      'requirements-apply',
    ].includes(command!);
    if (!values['dry-run'] && needsUser && !env.USER_TOKEN)
      throw new Error(
        'USER_TOKEN (COPILOT_ASSIGN_TOKEN) is required for dispatch/ai-command/self-heal/requirements-apply',
      );
    let appClient = createClient(token ?? '', env.GITHUB_API_URL);
    // Automerge and labels never instantiate a user-token client.
    let userClient = needsUser
      ? createClient(env.USER_TOKEN ?? '', env.GITHUB_API_URL)
      : appClient;
    if (values['dry-run']) {
      appClient = dryRunClient(appClient, log);
      userClient = dryRunClient(userClient, log);
    }
    let config = DEFAULT_CONFIG;
    // Publication only needs Issues permission; prompt building only uses read credentials.
    if (!['build-prompt', 'post-plan', 'post-answer'].includes(command!)) {
      const repo = await appClient.getRepo(event.repo);
      // Configuration is trusted default-branch data, never content from the PR head.
      config = await loadConfig(appClient, repo, repo.default_branch);
    }
    const deps = {
      event,
      appClient,
      userClient,
      config,
      log,
    };
    if (command === 'requirements') {
      const plan = (
        await requirements.scan(
          deps,
          values['dry-run'] ? undefined : values['output-dir'],
          requestedIssue,
        )
      ).map(({ issue, mode }) => ({ issue, mode }));
      log(JSON.stringify(plan));
      if (env.GITHUB_OUTPUT && !values['dry-run'])
        appendFileSync(env.GITHUB_OUTPUT, `plan=${JSON.stringify(plan)}\n`);
    } else if (command === 'requirements-apply') {
      const snapshot = requirements.readSnapshot(values['input-dir'] ?? 'out');
      let raw: string | undefined;
      if (snapshot.mode !== 'release') {
        try {
          raw = requirements.readArtifact(
            values['output-dir'] ?? 'out',
            'issues.json',
          );
        } catch {
          raw = '';
        } // Missing/oversized output follows the once-per-hash validation path.
      }
      return await requirements.apply(deps, snapshot, raw);
    } else if (command === 'build-prompt') {
      await buildPrompt.run(deps, {
        mode: parseMode(values.mode),
        outputDir: values['output-dir'],
        dryRun: values['dry-run'],
      });
    } else if (command === 'post-plan' || command === 'post-answer') {
      return await post.run(deps, {
        mode: command === 'post-plan' ? 'plan' : 'ask',
        outputDir: values['output-dir'],
      });
    } else if (command === 'dispatch' || command === 'ai-command') {
      const result = await (command === 'dispatch' ? dispatch : aiCommand).run(
        deps,
      );
      // Only fixed modes and validated numeric IDs cross the Actions output boundary.
      if (env.GITHUB_OUTPUT && !values['dry-run'])
        appendFileSync(
          env.GITHUB_OUTPUT,
          `mode=${result.mode}\nissue=${result.issue}\ncomment_id=${result.comment_id}\n`,
        );
    } else if (command === 'self-heal' || command === 'watchdog') {
      await (command === 'self-heal' ? selfHeal : watchdog).run(deps);
    } else {
      await (command === 'labels' ? labels : automerge).run(deps);
    }
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
