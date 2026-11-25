import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../src/config.js';
import { readEvent } from '../src/context.js';
import type { Dependencies } from '../src/commands/types.js';
import { FakeGitHubClient, FakeState } from '../src/github/fake.js';
import type { Issue } from '../src/github/client.js';

export const repo = 'acme/widget';
export const skipCases: [string, Partial<Issue>][] = [
  ['closed', { state: 'closed' }],
  [
    'pull-request',
    {
      pull_request: {
        url: 'https://api.github.com/repos/acme/widget/pulls/12',
      },
    },
  ],
  ['bot-author', { user: { login: 'automation', type: 'Bot' } }],
  ['association', { author_association: 'NONE' }],
  ['skip-label:ai:manual', { labels: ['ai:manual', 'requirements'] }],
  ['already-assigned', { assignees: [{ login: 'Copilot' }] }],
  ['task-issue', { body: '<!-- ai-factory:task req=1 id=health -->' }],
];
export function fixtureEnv(name = 'issues'): NodeJS.ProcessEnv {
  const files: Record<string, string> = {
    issues: 'issues.opened',
    pull_request_target: 'pull_request_target.ready_for_review',
    issue_comment: 'issue_comment.created',
    workflow_run: 'workflow_run.completed',
    schedule: 'schedule',
    workflow_dispatch: 'workflow_dispatch',
  };
  return {
    GITHUB_EVENT_NAME: name,
    GITHUB_REPOSITORY: repo,
    GITHUB_EVENT_PATH: fileURLToPath(
      new URL(`./fixtures/${files[name]}.json`, import.meta.url),
    ),
    COPILOT_BOT_LOGIN: 'factory-bot',
  };
}
export function setup(
  name: 'issues' | 'pull_request_target' | 'issue_comment' = 'issues',
) {
  const event = readEvent(fixtureEnv(name));
  const state = new FakeState();
  state.repositories.set(repo, { full_name: repo, default_branch: 'main' });
  if (event.name === 'issues' || event.name === 'issue_comment')
    state.issues.set(`${repo}#12`, structuredClone(event.issue));
  if (event.name === 'pull_request_target')
    state.pullRequests.set(`${repo}#13`, structuredClone(event.pullRequest));
  const appClient = new FakeGitHubClient(state, 'app');
  const userClient = new FakeGitHubClient(state, 'user');
  const logs: string[] = [];
  const deps: Dependencies = {
    event,
    appClient,
    userClient,
    config: structuredClone(DEFAULT_CONFIG),
    log: (message) => logs.push(message),
  };
  return { state, appClient, userClient, logs, deps };
}
