import { describe, expect, it, vi } from 'vitest';
import { run } from '../../src/commands/self-heal.js';
import { marker } from '../../src/markers.js';
import { repo } from '../helpers.js';
import { selfHealSetup } from '../phase3-helpers.js';

describe('self-heal', () => {
  it.each([
    'conclusion',
    'event',
    'fork',
    'base-repo',
    'non-copilot',
    'stale-sha',
    'missing-sha',
    'no-pr',
    'closed',
    'null-head-repo',
    'null-branch',
    'wrong-action',
  ])('skips %s with no writes', async (reason) => {
    const { deps, state, event, pr } = selfHealSetup();
    if (reason === 'conclusion') event.workflowRun.conclusion = 'success';
    if (reason === 'event') event.workflowRun.event = 'push';
    if (reason === 'fork')
      event.workflowRun.head_repository = { full_name: 'fork/widget' };
    if (reason === 'base-repo')
      event.workflowRun.repository.full_name = 'another/widget';
    if (reason === 'non-copilot') pr.user = { login: 'human', type: 'User' };
    if (reason === 'stale-sha') pr.head.sha = 'new-sha';
    if (reason === 'missing-sha') delete pr.head.sha;
    if (reason === 'no-pr') state.pullRequests.clear();
    if (reason === 'closed') pr.state = 'closed';
    if (reason === 'null-head-repo') event.workflowRun.head_repository = null;
    if (reason === 'null-branch') event.workflowRun.head_branch = null;
    if (reason === 'wrong-action') event.action = 'requested';
    await run(deps);
    expect(state.writes).toEqual([]);
  });
  it.each(['failure', 'timed_out'])(
    'posts a %s repair with user identity and rotates labels through the App',
    async (conclusion) => {
      const { deps, state, event, pr, userClient, appClient } = selfHealSetup();
      event.workflowRun.conclusion = conclusion;
      pr.labels = ['ai:fix-1'];
      await run(deps);
      await run(deps);
      expect(pr.labels).toEqual(['ai:fix-2']);
      expect(userClient.writes).toHaveLength(1);
      expect(userClient.writes[0]?.method).toBe('createComment');
      expect(appClient.writes.map((w) => w.method)).toEqual([
        'addLabels',
        'removeLabel',
      ]);
      const comment = state.comments.get(`${repo}#13`)![0]!;
      expect(comment.body).toMatch(/^\*\*CI repair requested/);
      expect(comment.body).toContain(
        '@copilot CI failed: CI / test (attempt 2 of 3)',
      );
      expect(comment.body).toContain('If the failure is not caused by this PR');
      expect(comment.body).toContain('Assertion failed');
      expect(comment.body).toMatch(
        /<!-- ai-factory:self-heal run=1234 attempt=2 -->$/,
      );
    },
  );
  it('recognizes an existing run receipt without another comment or counter increment', async () => {
    const { deps, state, pr } = selfHealSetup();
    pr.labels = ['ai:fix-1'];
    state.comments.set(`${repo}#13`, [
      {
        id: 1,
        body: marker('self-heal', { run: '1234', attempt: '1' }),
        user: { login: 'factory-bot', type: 'User' },
      },
    ]);
    await run(deps);
    expect(state.writes).toEqual([]);
  });
  it('does not trust a forged receipt from another commenter', async () => {
    const { deps, state } = selfHealSetup();
    state.comments.set(`${repo}#13`, [
      {
        id: 1,
        body: marker('self-heal', { run: '1234', attempt: '10' }),
        user: { login: 'attacker', type: 'User' },
      },
    ]);
    await run(deps);
    expect(
      state.writes.some(
        (w) => w.method === 'createComment' && w.identity === 'user',
      ),
    ).toBe(true);
  });
  it.each([0, 3])(
    'gives up once at limit %s and mentions escalation users via the App',
    async (limit) => {
      const { deps, state, event, pr, userClient } = selfHealSetup();
      deps.config.max_fix_attempts = limit;
      deps.config.escalate_to = ['alice', 'bob'];
      if (limit) pr.labels = [`ai:fix-${limit}`];
      await run(deps);
      await run(deps);
      event.workflowRun.id = 9999;
      await run(deps);
      expect(pr.labels).toContain('ai:human-needed');
      expect(userClient.writes).toEqual([]);
      expect(
        state.writes.filter((w) => w.method === 'createComment'),
      ).toHaveLength(1);
      expect(state.comments.get(`${repo}#13`)![0]?.body).toContain(
        '@alice @bob',
      );
      expect(state.comments.get(`${repo}#13`)![0]?.body).toContain(
        'run=1234 state=gave-up',
      );
    },
  );
  it('downloads at most three failed jobs, ignoring successful jobs and sanitizing secrets', async () => {
    const { deps, state, appClient } = selfHealSetup();
    state.jobs.set(
      `${repo}#1234`,
      [0, 1, 2, 3, 4].map((id) => ({
        id,
        name: `job-${id}`,
        conclusion: id ? 'failure' : 'success',
      })),
    );
    for (const id of [1, 2, 3, 4])
      state.jobLogs.set(`${repo}#${id}`, 'safe\nghp_do-not-post');
    const download = vi.spyOn(appClient, 'downloadJobLog');
    await run(deps);
    expect(download).toHaveBeenCalledTimes(3);
    const body = state.comments.get(`${repo}#13`)![0]!.body;
    expect(body).not.toContain('ghp_');
    expect(body).toContain('[redacted]');
    expect(body).not.toContain('job-4');
  });
  it('bounds an oversized escalation list while preserving the run link and final marker', async () => {
    const { deps, state, event } = selfHealSetup();
    deps.config.max_fix_attempts = 0;
    deps.config.escalate_to = Array.from(
      { length: 10000 },
      (_, n) => `user-${n}`,
    );
    await run(deps);
    const body = state.comments.get(`${repo}#13`)![0]!.body;
    expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(60000);
    expect(body).toContain(event.workflowRun.html_url);
    expect(body).toMatch(
      /<!-- ai-factory:self-heal run=1234 state=gave-up -->$/,
    );
  });
  it('does not consume an attempt when downloading logs fails', async () => {
    const { deps, state, appClient } = selfHealSetup();
    vi.spyOn(appClient, 'downloadJobLog').mockRejectedValue(
      new Error('download failed'),
    );
    await expect(run(deps)).rejects.toThrow('download failed');
    expect(state.writes).toEqual([]);
  });
  it('rechecks the head SHA after downloading logs', async () => {
    const { deps, state, pr, appClient } = selfHealSetup();
    vi.spyOn(appClient, 'downloadJobLog').mockImplementation(async () => {
      pr.head.sha = 'new-push';
      return 'log';
    });
    await run(deps);
    expect(state.writes).toEqual([]);
  });
  it('repairs a failed label write from the receipt without requesting a second repair', async () => {
    const { deps, state, pr, appClient } = selfHealSetup();
    vi.spyOn(appClient, 'addLabels').mockRejectedValueOnce(
      new Error('temporary'),
    );
    await expect(run(deps)).rejects.toThrow('temporary');
    await run(deps);
    expect(pr.labels).toEqual(['ai:fix-1']);
    expect(
      state.writes.filter((w) => w.method === 'createComment'),
    ).toHaveLength(1);
  });
  it('does not consume an attempt when the user comment fails', async () => {
    const { deps, state, userClient } = selfHealSetup();
    vi.spyOn(userClient, 'createComment').mockRejectedValueOnce(
      new Error('temporary'),
    );
    await expect(run(deps)).rejects.toThrow('temporary');
    expect(state.writes).toEqual([]);
    await run(deps);
    expect(state.comments.get(`${repo}#13`)![0]!.body).toContain('attempt=1');
  });
  it('rejects ambiguous branch matches rather than commenting on an arbitrary PR', async () => {
    const { deps, state, pr } = selfHealSetup();
    state.pullRequests.set(`${repo}#14`, {
      ...structuredClone(pr),
      number: 14,
    });
    await run(deps);
    expect(state.writes).toEqual([]);
  });
});
