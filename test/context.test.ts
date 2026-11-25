import { describe, expect, it } from 'vitest';
import { parseIssue, parsePullRequest, readEvent } from '../src/context.js';
import { fixtureEnv, setup } from './helpers.js';

describe('typed GitHub events', () => {
  it.each([
    'issues',
    'issue_comment',
    'pull_request_target',
    'workflow_run',
    'schedule',
    'workflow_dispatch',
  ])('reads a trimmed %s webhook fixture', (name) => {
    expect(readEvent(fixtureEnv(name))).toMatchObject({
      name,
      repo: 'acme/widget',
    });
  });
  it('normalizes label objects and preserves bot identity', () => {
    const event = readEvent(fixtureEnv('issue_comment'));
    expect(event).toMatchObject({
      issue: { labels: ['ai:in-progress'] },
      botLogin: 'factory-bot',
    });
  });
  it('rejects unknown events and missing context clearly', () => {
    expect(() =>
      readEvent({ ...fixtureEnv(), GITHUB_EVENT_NAME: 'push' }),
    ).toThrow('Unsupported GitHub event: push');
    expect(() => readEvent({ GITHUB_EVENT_NAME: 'issues' })).toThrow(
      'GITHUB_EVENT_PATH',
    );
    expect(() =>
      readEvent({ ...fixtureEnv(), GITHUB_REPOSITORY: 'wrong' }),
    ).toThrow('OWNER/REPO');
  });
  it('rejects incomplete issue and PR payloads rather than making unsafe assumptions', () => {
    expect(() => parseIssue({ number: 12 })).toThrow();
    expect(() => parsePullRequest({ number: 13, draft: false })).toThrow();
    const { deps } = setup();
    if (deps.event.name !== 'issues') throw new Error('Expected issue fixture');
    expect(
      parseIssue({
        ...deps.event.issue,
        labels: [{ name: 'ai:manual' }],
        pull_request: { url: 'pr-url' },
      }),
    ).toMatchObject({ labels: ['ai:manual'], pull_request: { url: 'pr-url' } });
  });
});
