import { describe, expect, it, vi } from 'vitest';
import { linkedIssues, run } from '../../src/commands/automerge.js';
import type { PullRequest } from '../../src/github/client.js';
import { repo, setup } from '../helpers.js';

describe('automerge command', () => {
  it.each<[string, Partial<PullRequest>]>([
    ['non-copilot-author', { user: { login: 'human', type: 'User' } }],
    ['draft', { draft: true }],
    [
      'fork',
      {
        head: { ref: 'copilot/change', repo: { full_name: 'attacker/widget' } },
      },
    ],
    ['fork', { head: { ref: 'copilot/change', repo: null } }],
    ['base-branch', { base: { ref: 'other', repo: { full_name: repo } } }],
    ['closed', { state: 'closed' }],
  ])('skips %s without writes', async (reason, patch) => {
    const { deps, state, logs } = setup('pull_request_target');
    Object.assign(state.pullRequests.get(`${repo}#13`)!, patch);
    await run(deps);
    expect(state.writes).toEqual([]);
    expect(logs).toContain(`::notice::${reason}`);
  });
  it.each(['squash', 'merge', 'rebase'] as const)(
    'enables %s once, labels and splits/deduplicates reviewers while excluding bot identities',
    async (method) => {
      const { deps, state, userClient, logs } = setup('pull_request_target');
      deps.config.merge_method = method;
      deps.config.reviewers = [
        'alice',
        'Alice',
        'acme/platform',
        'ACME/PLATFORM',
        'factory-bot',
        'FACTORY-BOT',
        'Copilot',
        'copilot-swe-agent[bot]',
        'other[bot]',
      ];
      await run(deps);
      await run(deps);
      expect(state.writes.map((call) => call.method)).toEqual([
        'enablePullRequestAutoMerge',
        'requestReviewers',
        'addLabels',
      ]);
      expect(state.writes[0]?.args).toEqual([repo, 'PR_kwDOExample', method]);
      expect(state.writes[1]?.args).toEqual([
        repo,
        13,
        ['alice'],
        ['platform'],
      ]);
      expect(userClient.writes).toHaveLength(0);
      expect(logs).toContain('Linked issues: #12');
    },
  );
  it('does not enable existing auto-merge or request reviewers already pending', async () => {
    const { deps, state } = setup('pull_request_target');
    Object.assign(state.pullRequests.get(`${repo}#13`)!, {
      auto_merge: { merge_method: 'merge' },
      labels: ['ai:awaiting-review'],
      requested_reviewers: [{ login: 'Alice' }],
      requested_teams: [{ slug: 'platform' }],
      body: null,
    });
    deps.config.reviewers = ['alice', 'acme/platform'];
    await run(deps);
    expect(state.writes).toHaveLength(0);
  });
  it('requires bot identity for configured user reviewers before writing', async () => {
    const { deps, state } = setup('pull_request_target');
    delete deps.event.botLogin;
    deps.config.reviewers = ['alice'];
    await expect(run(deps)).rejects.toThrow('COPILOT_BOT_LOGIN');
    expect(state.writes).toHaveLength(0);
  });
  it('does not request completed reviews again after pending lists become empty', async () => {
    const { deps, state } = setup('pull_request_target');
    deps.config.reviewers = ['alice', 'acme/platform'];
    await run(deps);
    const pr = state.pullRequests.get(`${repo}#13`)!;
    pr.requested_reviewers = [];
    pr.requested_teams = [];
    await run(deps);
    expect(
      state.writes.filter((call) => call.method === 'requestReviewers'),
    ).toHaveLength(1);
  });
  it('recovers when requesting reviews fails without marking setup complete', async () => {
    const { deps, state, appClient } = setup('pull_request_target');
    deps.config.reviewers = ['alice'];
    vi.spyOn(appClient, 'requestReviewers').mockRejectedValueOnce(
      new Error('temporary failure'),
    );
    await expect(run(deps)).rejects.toThrow('temporary failure');
    expect(state.pullRequests.get(`${repo}#13`)!.labels).toEqual([]);
    await run(deps);
    expect(state.writes.map((call) => call.method)).toEqual([
      'enablePullRequestAutoMerge',
      'requestReviewers',
      'addLabels',
    ]);
  });
  it('recovers a failed completion label without repeating pending review requests', async () => {
    const { deps, state, appClient } = setup('pull_request_target');
    deps.config.reviewers = ['alice', 'acme/platform'];
    vi.spyOn(appClient, 'addLabels').mockRejectedValueOnce(
      new Error('temporary failure'),
    );
    await expect(run(deps)).rejects.toThrow('temporary failure');
    await run(deps);
    expect(state.writes.map((call) => call.method)).toEqual([
      'enablePullRequestAutoMerge',
      'requestReviewers',
      'addLabels',
    ]);
  });
  it('does not need a bot login for empty reviewer lists or teams only', async () => {
    for (const reviewers of [[], ['acme/platform']]) {
      const { deps, state } = setup('pull_request_target');
      delete deps.event.botLogin;
      deps.config.reviewers = reviewers;
      await run(deps);
      expect(state.writes.length).toBeGreaterThanOrEqual(2);
    }
  });
  it('does not silently convert a different organization team into a local team', async () => {
    const { deps, state } = setup('pull_request_target');
    deps.config.reviewers = ['elsewhere/platform'];
    await expect(run(deps)).rejects.toThrow('org/team');
    expect(state.writes).toHaveLength(0);
  });
  it('skips unsupported triggers', async () => {
    const { deps, state } = setup('pull_request_target');
    if (deps.event.name !== 'pull_request_target')
      throw new Error('Expected PR fixture');
    deps.event.action = 'synchronize';
    await run(deps);
    expect(state.writes).toHaveLength(0);
    const other = setup();
    await run(other.deps);
    expect(other.state.writes).toHaveLength(0);
  });
  it('parses local closing references case-insensitively, deduplicates, and ignores other repos', () => {
    expect(
      linkedIssues(
        'FIXES #12, Closes #15; resolves acme/widget#16. fixes #12. Closes other/widget#99; fixes https://github.com/other/widget/issues/20; prefixes #21; fixes #0',
        repo,
      ),
    ).toEqual([12, 15, 16]);
    expect(linkedIssues(null, repo)).toEqual([]);
    expect(linkedIssues('No linked issue', repo)).toEqual([]);
  });
});
