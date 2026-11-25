import { expect, it } from 'vitest';
import {
  computeMetrics,
  humanRequestedChanges,
  median,
  metricsWindow,
  renderMetrics,
  withinWindow,
} from '../src/metrics.js';
import {
  appActor,
  botUser,
  feedback,
  human,
  metricsFixture,
  NOW,
} from './metrics-helpers.js';

it('uses inclusive UTC event-time windows and validates duration syntax', () => {
  expect(metricsWindow('30d', NOW).since).toBe('2026-10-26T12:00:00.000Z');
  expect(metricsWindow('24h', NOW)).toEqual(metricsWindow('1d', NOW));
  expect(metricsWindow('4w', NOW)).toEqual(metricsWindow('28d', NOW));
  const window = metricsWindow('30d', NOW);
  expect(withinWindow(window.since, window)).toBe(true);
  expect(withinWindow(window.until, window)).toBe(true);
  for (const date of [
    undefined,
    null,
    'invalid',
    '2026-10-26T11:59:59Z',
    '2026-11-25T12:00:01Z',
  ])
    expect(withinWindow(date, window)).toBe(false);
  for (const since of [
    '0d',
    '-1d',
    '1.5d',
    '30',
    'today',
    '999999999999999999d',
  ])
    expect(() => metricsWindow(since, NOW)).toThrow();
  expect(() => metricsWindow('1d', new Date('invalid'))).toThrow();
});
it('computes medians without mutating samples and represents no samples as null', () => {
  const samples = [10, 2, 4];
  expect(median(samples)).toBe(4);
  expect(samples).toEqual([10, 2, 4]);
  expect(median([10, 2])).toBe(6);
  expect(median([])).toBeNull();
});
it('computes every metric, including old PRs merged in-window and deduplicated repair receipts', () => {
  const result = computeMetrics(metricsFixture());
  expect(result.pull_requests).toEqual({
    opened: 2,
    merged: 2,
    closed_unmerged: 1,
    median_issue_to_merge_hours: 72,
    issue_to_merge_samples: 2,
    merged_without_human_changes: 1,
    merged_without_human_changes_share: 0.5,
  });
  expect(result.self_heal).toMatchObject({
    per_pr: [
      { pr: 13, attempts: 2, gave_up: true },
      { pr: 15, attempts: 1, gave_up: false },
    ],
    mean_attempts_per_pr: 1.5,
    observed_prs: 2,
    gave_up: 1,
    gave_up_share: 0.5,
  });
  expect(result.requirements).toEqual({
    tasks_created: 1,
    tasks_closed: 2,
    issues_fully_closed: 1,
  });
  expect(renderMetrics(result)).toContain('| Copilot PRs merged | 2 |');
  expect(renderMetrics(result)).toContain('| #13 | 2 | yes |');
});
it.each(['@copilot please fix', 'Please @COPILOT: fix', 'Review: (@copilot)'])(
  'recognizes the human mention signal: %s',
  (body) => {
    expect(
      humanRequestedChanges([feedback(body)], NOW.toISOString(), botUser.login),
    ).toBe(true);
  },
);
it('excludes ordinary reviews, bots, automation users, invalid dates and post-merge mentions', () => {
  for (const comment of [
    feedback('Approved'),
    feedback('Changes requested'),
    feedback('@copilot', appActor),
    feedback('@copilot', botUser),
    feedback('@copilot', { login: 'odd[bot]', type: 'User' }),
    feedback('@copilot-other'),
    feedback('person@copilot.example'),
    feedback('@copilot', human, 'invalid'),
    feedback('@copilot', human, '2026-12-01T00:00:00Z'),
  ])
    expect(
      humanRequestedChanges([comment], NOW.toISOString(), botUser.login),
    ).toBe(false);
});
it('counts mentions in submitted and inline reviews and ignores feedback after merge', () => {
  const input = metricsFixture();
  input.reviewFeedback.set(14, [feedback('@copilot fix the test')]);
  expect(
    computeMetrics(input).pull_requests.merged_without_human_changes_share,
  ).toBe(0);
  input.reviewFeedback.set(14, [
    feedback('@copilot future request', human, '2026-11-21T12:00:00Z'),
  ]);
  expect(
    computeMetrics(input).pull_requests.merged_without_human_changes_share,
  ).toBe(0.5);
});
it('excludes missing/foreign/future issue links and uses one earliest-issue sample per merged PR', () => {
  const input = metricsFixture();
  input.prs[0]!.body = 'Fixes foreign/repo#101; closes #999';
  input.prs[1]!.body = 'Fixes #101 and resolves #102';
  expect(computeMetrics(input).pull_requests).toMatchObject({
    issue_to_merge_samples: 1,
    median_issue_to_merge_hours: 288,
  });
  input.issues[0]!.created_at = 'invalid';
  input.issues[1]!.created_at = '2026-12-01T00:00:00Z';
  expect(
    computeMetrics(input).pull_requests.median_issue_to_merge_hours,
  ).toBeNull();
});
it('reports no-data shares as null/N/A and does not trust forged task/completion markers', () => {
  const input = metricsFixture();
  input.prs = [];
  input.issues.forEach((i) => (i.user = human));
  input.comments.get(200)![0]!.user = human;
  const result = computeMetrics(input);
  expect(result.self_heal.gave_up_share).toBeNull();
  expect(result.pull_requests.merged_without_human_changes_share).toBeNull();
  expect(result.requirements).toEqual({
    tasks_created: 0,
    tasks_closed: 0,
    issues_fully_closed: 0,
  });
  expect(renderMetrics(result)).toContain('N/A');
});
it('excludes reopened requirements and stale completion hashes and exposes missing bot identity coverage', () => {
  const input = metricsFixture();
  input.issues.find((i) => i.number === 200)!.body = 'edited after completion';
  expect(computeMetrics(input).requirements.issues_fully_closed).toBe(0);
  input.issues.find((i) => i.number === 200)!.body = 'Feature';
  input.issues.find((i) => i.number === 200)!.state = 'open';
  expect(computeMetrics(input).requirements.issues_fully_closed).toBe(0);
  delete input.botLogin;
  const result = computeMetrics(input);
  expect(result.self_heal.user_receipts_included).toBe(false);
  expect(renderMetrics(result)).toContain('COPILOT_BOT_LOGIN is unset');
});
