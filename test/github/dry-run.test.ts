import { expect, it, vi } from 'vitest';
import { dryRunClient } from '../../src/github/dry-run.js';
import { repo, setup } from '../helpers.js';

it('suppresses every write method, including automerge, reviews, reactions and comment updates', async () => {
  const { appClient, state } = setup();
  const logs: string[] = [];
  const client = dryRunClient(appClient, (line) => logs.push(line));
  await client.createComment(repo, 12, 'body');
  await client.updateComment(repo, 1, 'body');
  await client.addLabels(repo, 12, ['label']);
  await client.removeLabel(repo, 12, 'label');
  await client.enablePullRequestAutoMerge(repo, 'node-id', 'squash');
  await client.requestReviewers(repo, 13, ['human'], ['team']);
  await client.addReaction(repo, 1, 'eyes');
  await client.removeAssignees(repo, 12, ['copilot-swe-agent[bot]']);
  await client.assignCopilot(repo, 12, {
    assignees: ['copilot-swe-agent[bot]'],
    agent_assignment: {
      target_repo: repo,
      base_branch: 'main',
      custom_instructions: 'test',
    },
  });
  const labels = vi.spyOn(appClient, 'ensureLabels');
  expect(
    await client.ensureLabels(repo, [
      { name: 'test', color: '123456', description: 'test' },
    ]),
  ).toEqual([{ name: 'test', status: 'created' }]);
  expect(labels).toHaveBeenCalledWith(
    repo,
    [{ name: 'test', color: '123456', description: 'test' }],
    true,
  );
  expect(await client.getIssue(repo, 12)).toMatchObject({ number: 12 });
  expect(logs).toHaveLength(10);
  expect(state.writes).toHaveLength(0);
});
