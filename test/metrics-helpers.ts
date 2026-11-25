import type { Comment, Issue, PullRequest } from '../src/github/client.js';
import { metricsWindow, type MetricsInput } from '../src/metrics.js';
import { marker } from '../src/markers.js';
import { hashBody } from '../src/requirements/state.js';
import { repo, setup } from './helpers.js';
export const NOW = new Date('2026-11-25T12:00:00Z');
export const appActor = { login: 'ai-factory[bot]', type: 'Bot' };
export const human = { login: 'alice', type: 'User' };
export const botUser = { login: 'factory-bot', type: 'User' };
export function feedback(
  body: string,
  user = human,
  date = '2026-11-01T12:00:00Z',
  id = 1,
): Comment {
  return { id, body, user, created_at: date };
}
export function metricsFixture(): MetricsInput {
  const prBase = [
    ...setup('pull_request_target').state.pullRequests.values(),
  ][0]!;
  const issueBase = [...setup().state.issues.values()][0]!;
  const pr = (number: number, changes: Partial<PullRequest>): PullRequest => ({
    ...prBase,
    number,
    node_id: `PR_${number}`,
    created_at: '2026-11-01T12:00:00Z',
    ...changes,
  });
  const issue = (number: number, changes: Partial<Issue>): Issue => ({
    ...issueBase,
    number,
    id: 10000 + number,
    body: 'Feature',
    labels: [],
    created_at: '2026-11-01T12:00:00Z',
    ...changes,
  });
  return {
    repo,
    window: metricsWindow('30d', NOW),
    factoryLogin: appActor.login,
    botLogin: botUser.login,
    prs: [
      pr(13, {
        created_at: '2026-10-01T12:00:00Z',
        state: 'closed',
        merged_at: '2026-11-10T12:00:00Z',
        closed_at: '2026-11-10T12:00:00Z',
        body: 'Fixes #101',
      }),
      pr(14, {
        state: 'closed',
        merged_at: '2026-11-20T12:00:00Z',
        closed_at: '2026-11-20T12:00:00Z',
        body: 'Closes #102',
      }),
      pr(15, {
        state: 'closed',
        closed_at: '2026-11-12T12:00:00Z',
        body: null,
      }),
      pr(16, { created_at: '2026-11-26T12:00:00Z' }),
      pr(17, {
        user: human,
        state: 'closed',
        merged_at: '2026-11-20T12:00:00Z',
      }),
    ],
    issues: [
      issue(101, { created_at: '2026-11-08T12:00:00Z' }),
      issue(102, { created_at: '2026-11-16T12:00:00Z' }),
      issue(200, {
        state: 'closed',
        closed_at: '2026-11-20T12:00:00Z',
        labels: ['requirements'],
      }),
      issue(201, {
        user: appActor,
        state: 'closed',
        closed_at: '2026-11-18T12:00:00Z',
        body: marker('task', { req: '200', id: 'a' }),
      }),
      issue(202, {
        user: appActor,
        created_at: '2026-10-01T12:00:00Z',
        state: 'closed',
        closed_at: '2026-11-10T12:00:00Z',
        body: marker('task', { req: '200', id: 'b' }),
      }),
      issue(203, {
        state: 'closed',
        closed_at: '2026-11-20T12:00:00Z',
        labels: ['requirements'],
      }),
    ],
    comments: new Map([
      [
        13,
        [
          feedback('@copilot please fix this', human, '2026-10-20T12:00:00Z'),
          feedback(marker('self-heal', { run: '1', attempt: '1' }), botUser),
          feedback(marker('self-heal', { run: '1', attempt: '1' }), botUser),
          feedback(marker('self-heal', { run: '2', attempt: '2' }), botUser),
          feedback(
            marker('self-heal', { run: '2', state: 'gave-up' }),
            appActor,
          ),
          feedback(
            marker('self-heal', { run: '3', attempt: '3' }),
            botUser,
            '2026-10-01T12:00:00Z',
          ),
          feedback(marker('self-heal', { run: '99', attempt: '9' }), human),
        ],
      ],
      [
        15,
        [feedback(marker('self-heal', { run: '4', attempt: '1' }), botUser)],
      ],
      [
        200,
        [
          feedback(
            marker('review', { kind: 'complete', hash: hashBody('Feature') }),
            appActor,
          ),
        ],
      ],
    ]),
    reviewFeedback: new Map([[14, [feedback('Approved, looks good')]]]),
  };
}
