import { readEvent } from '../src/context.js';
import { fixtureEnv, repo, setup } from './helpers.js';

export const NOW = new Date('2026-11-25T12:00:00Z');
export function selfHealSetup() {
  const result = setup('pull_request_target');
  const event = readEvent(fixtureEnv('workflow_run'));
  if (event.name !== 'workflow_run') throw new Error('Expected workflow run');
  result.deps.event = event;
  result.state.now = NOW.toISOString();
  result.state.jobs.set(`${repo}#1234`, [
    { id: 1, name: 'test', conclusion: 'failure' },
  ]);
  result.state.jobLogs.set(
    `${repo}#1`,
    '2026-11-25T10:00:00Z Assertion failed',
  );
  return { ...result, event, pr: result.state.pullRequests.get(`${repo}#13`)! };
}
export function watchdogSetup() {
  const result = setup('pull_request_target');
  result.deps.event = readEvent(fixtureEnv('schedule'));
  result.state.now = NOW.toISOString();
  const issue = setup().state.issues.get(`${repo}#12`)!;
  issue.labels = ['ai:in-progress'];
  issue.assignees = [{ login: 'Copilot' }];
  result.state.issues.set(`${repo}#12`, issue);
  return { ...result, issue, pr: result.state.pullRequests.get(`${repo}#13`)! };
}
