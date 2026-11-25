import { describe, expect, it } from 'vitest';
import { isStale, linkedIssues, needsStaleComment } from '../src/watchdog.js';
import { run } from '../src/commands/watchdog.js';
import { marker } from '../src/markers.js';
import { NOW, watchdogSetup } from './phase3-helpers.js';
import { repo } from './helpers.js';

describe('watchdog decisions', () => {
  it('uses a strict inactivity boundary and ignores missing/invalid/future times', () => {
    expect(isStale('2026-11-25T05:59:59Z', NOW, 6)).toBe(true);
    for (const value of [
      undefined,
      'invalid',
      '2026-11-25T06:00:00Z',
      '2026-11-25T15:00:00Z',
    ])
      expect(isStale(value, NOW, 6)).toBe(false);
  });
  it('only needs a new notification after activity later than the previous notification', () => {
    expect(needsStaleComment([], '2026-11-25T00:00:00Z')).toBe(true);
    expect(
      needsStaleComment([{ created_at: NOW.toISOString() }], NOW.toISOString()),
    ).toBe(false);
    expect(
      needsStaleComment(
        [{ created_at: '2026-11-25T01:00:00Z' }],
        '2026-11-25T02:00:00Z',
      ),
    ).toBe(true);
  });
  it('reuses the same-repository closing-reference parser', () => {
    expect(linkedIssues('Fixes #1')).toEqual([1]);
    expect(
      linkedIssues(
        'Fixes #1, CLOSES acme/widget#2, resolves other/widget#3',
        repo,
      ),
    ).toEqual([1, 2]);
  });
});

describe('watchdog command', () => {
  it('notifies a stale draft PR once, mentions the issue author, and does not count its own writes as new activity', async () => {
    const { deps, state, pr } = watchdogSetup();
    pr.draft = true;
    await run(deps, NOW);
    expect(pr.labels).toContain('ai:stale');
    expect(state.comments.get(`${repo}#13`)![0]!.body).toContain('@maintainer');
    expect(state.comments.get(`${repo}#13`)![0]!.body).toMatch(
      /<!-- ai-factory:stale kind=pr -->$/,
    );
    const count = state.writes.length;
    await run(deps, NOW);
    await run(deps, new Date('2026-11-26T12:00:00Z'));
    expect(state.writes).toHaveLength(count);
  });
  it('notifies again after real new PR activity subsequently goes stale', async () => {
    const { deps, state, pr } = watchdogSetup();
    pr.draft = true;
    await run(deps, NOW);
    pr.updated_at = '2026-11-25T13:00:00Z';
    state.now = '2026-11-26T12:00:00Z';
    await run(deps, new Date(state.now));
    expect(state.comments.get(`${repo}#13`)).toHaveLength(2);
  });
  it('notifies an assigned stale issue with no PR once', async () => {
    const { deps, state, issue } = watchdogSetup();
    state.pullRequests.clear();
    await run(deps, NOW);
    await run(deps, new Date('2026-11-26T12:00:00Z'));
    expect(issue.labels).toContain('ai:stale');
    expect(state.comments.get(`${repo}#12`)).toHaveLength(1);
    expect(state.comments.get(`${repo}#12`)![0]!.body).toMatch(
      /<!-- ai-factory:stale kind=issue -->$/,
    );
  });
  it.each(['body', 'timeline'])(
    'does not flag an issue connected to an open ready PR by %s',
    async (via) => {
      const { deps, state, pr } = watchdogSetup();
      if (via === 'timeline') {
        pr.body = '';
        state.crossReferences.set(`${repo}#12`, [{ repo, number: 13 }]);
      }
      await run(deps, NOW);
      expect(state.writes).toEqual([]);
    },
  );
  it('honors a local human PR in the timeline, ignoring cross-repository references', async () => {
    const { deps, state, pr } = watchdogSetup();
    pr.user = { login: 'human', type: 'User' };
    pr.body = '';
    state.crossReferences.set(`${repo}#12`, [
      { repo, number: 13 },
      { repo: 'other/widget', number: 9 },
    ]);
    await run(deps, NOW);
    expect(state.writes).toEqual([]);
  });
  it.each([null, '2026-11-25T10:00:00Z'])(
    'cleans linked issue labels after closed/merged PR (merged_at=%s)',
    async (mergedAt) => {
      const { deps, state, pr, issue } = watchdogSetup();
      pr.state = 'closed';
      pr.merged_at = mergedAt;
      issue.state = 'closed';
      issue.labels.push('ai:awaiting-review');
      await run(deps, NOW);
      await run(deps, NOW);
      expect(issue.labels).toEqual([]);
      expect(state.writes.map((w) => w.method)).toEqual([
        'removeLabel',
        'removeLabel',
      ]);
    },
  );
  it('does not clear work-in-progress for an older closed PR when a replacement PR is still open', async () => {
    const { deps, state, pr, issue } = watchdogSetup();
    state.pullRequests.set(`${repo}#14`, {
      ...structuredClone(pr),
      number: 14,
      state: 'closed',
    });
    await run(deps, NOW);
    expect(issue.labels).toContain('ai:in-progress');
    expect(state.writes).toEqual([]);
  });
  it('ignores an attacker-supplied stale marker', async () => {
    const { deps, state } = watchdogSetup();
    state.pullRequests.clear();
    state.comments.set(`${repo}#12`, [
      {
        id: 1,
        body: marker('stale', { kind: 'issue' }),
        created_at: NOW.toISOString(),
        user: { login: 'attacker', type: 'User' },
      },
    ]);
    await run(deps, NOW);
    expect(state.writes.some((w) => w.method === 'createComment')).toBe(true);
  });
  it('caps processing at 50 items and logs a summary; later runs progress to remaining issues', async () => {
    const { deps, state, issue, logs } = watchdogSetup();
    state.pullRequests.clear();
    state.issues.clear();
    for (let number = 1; number <= 55; number++)
      state.issues.set(`${repo}#${number}`, {
        ...structuredClone(issue),
        number,
      });
    await run(deps, NOW);
    expect(
      state.writes.filter((w) => w.method === 'createComment'),
    ).toHaveLength(50);
    expect(logs).toContain('Processed 50 of 55 candidates (limit 50).');
    await run(deps, NOW);
    expect(
      state.writes.filter((w) => w.method === 'createComment'),
    ).toHaveLength(55);
  });
  it('ignores fresh or unassigned issues and non-Copilot draft PRs', async () => {
    const { deps, state, issue, pr } = watchdogSetup();
    pr.user = { login: 'human', type: 'User' };
    pr.draft = true;
    pr.body = '';
    issue.assignees = [];
    await run(deps, NOW);
    expect(state.writes).toEqual([]);
    issue.assignees = [{ login: 'Copilot' }];
    issue.updated_at = NOW.toISOString();
    await run(deps, NOW);
    expect(state.writes).toEqual([]);
  });
});
