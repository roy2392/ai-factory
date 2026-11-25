import { expect, it, vi } from 'vitest';
import { apply, inspect, scan } from '../../src/commands/requirements.js';
import { findMarkers } from '../../src/markers.js';
import { proposed, requirementsSetup } from '../requirements/helpers.js';
import { repo } from '../helpers.js';
import type { GitHubClient } from '../../src/github/client.js';

async function interruptNewLink(client: GitHubClient) {
  const ids = new Set((await client.listSubIssues(repo, 12)).map((i) => i.id));
  const add = client.addSubIssue.bind(client);
  let failed = false;
  vi.spyOn(client, 'addSubIssue').mockImplementation(async (...args) => {
    if (!failed && !ids.has(args[2])) {
      failed = true;
      throw new Error('interrupted');
    }
    await add(...args);
  });
}

const four = JSON.stringify([
  proposed('a'),
  proposed('b'),
  proposed('c'),
  proposed('d', ['a']),
]);
it('an empty first analysis closes immediately with the specified receipt and reviewed hash', async () => {
  const { deps, state, parent, userClient } = requirementsSetup();
  const [analysis] = await scan(deps);
  await apply(deps, analysis!, '[]');
  const view = await inspect(deps, 12);
  expect(parent.state).toBe('closed');
  expect(view.tasks).toEqual([]);
  expect(view.state).toMatchObject({
    hash: analysis!.hash,
    reviewed_hash: analysis!.hash,
    review_rounds: 0,
  });
  const completion = view.comments.filter((c) =>
    findMarkers(c.body, 'review').some((m) => m.attrs.kind === 'complete'),
  );
  expect(completion).toHaveLength(1);
  expect(completion[0]?.body).toBe(
    `**Nothing to implement: the repository already covers these requirements.**\n\n<!-- ai-factory:review kind=complete hash=${analysis!.hash} -->`,
  );
  expect(userClient.writes).toEqual([]);
  const writes = state.writes.length;
  await apply(deps, analysis!, '[]');
  expect(await scan(deps)).toEqual([]);
  expect(state.writes).toHaveLength(writes);
});
it('recovers an empty-analysis completion when state creation failed, even with zero tasks', async () => {
  const { deps, appClient, parent } = requirementsSetup();
  const [analysis] = await scan(deps);
  const create = appClient.createComment.bind(appClient);
  let count = 0;
  vi.spyOn(appClient, 'createComment').mockImplementation(async (...args) => {
    if (++count === 2) throw new Error('interrupted state write');
    await create(...args);
  });
  await expect(apply(deps, analysis!, '[]')).rejects.toThrow('interrupted');
  expect((await inspect(deps, 12)).state).toBeNull();
  await apply(deps, analysis!, '[]');
  expect(parent.state).toBe('closed');
  expect(
    (await inspect(deps, 12)).comments.filter((c) =>
      findMarkers(c.body, 'review').some((m) => m.attrs.kind === 'complete'),
    ),
  ).toHaveLength(1);
});
it('empty edited analysis keeps existing open work active and resets review rounds', async () => {
  const { deps, parent } = requirementsSetup();
  await apply(deps, (await scan(deps))[0]!, four);
  parent.body += '\nUpdated requirements';
  await apply(deps, (await scan(deps))[0]!, '[]');
  expect(parent.state).toBe('open');
  expect((await inspect(deps, 12)).state).toMatchObject({
    reviewed_hash: '',
    review_rounds: 0,
  });
});
it('three gap rounds escalate once, never schedule a fourth review, and an edit resets the rounds', async () => {
  const { deps, parent, state, appClient } = requirementsSetup();
  await apply(deps, (await scan(deps))[0]!, four);
  const closeTasks = () => {
    for (const i of state.issues.values())
      if (i.number !== 12) i.state = 'closed';
  };
  closeTasks();
  for (let round = 0; round < 3; round++) {
    const [review] = await scan(deps);
    expect(review).toMatchObject({ mode: 'review', review_rounds: round });
    const raw = JSON.stringify([proposed(`gap-${round}`)]);
    await apply(deps, review!, raw);
    expect((await inspect(deps, 12)).state).toMatchObject({
      review_rounds: round + 1,
      reviewed_hash: '',
    });
    const writes = state.writes.length;
    await apply(deps, review!, raw);
    expect(state.writes).toHaveLength(writes);
    // The third round's tasks still run to completion before escalation.
    expect(parent.labels).not.toContain('ai:human-needed');
    closeTasks();
  }
  const [cap] = await scan(deps);
  expect(cap).toMatchObject({ mode: 'release', review_rounds: 3 });
  vi.spyOn(appClient, 'createComment').mockRejectedValueOnce(
    new Error('interrupted cap notice'),
  );
  await expect(apply(deps, cap!)).rejects.toThrow('interrupted cap');
  expect(parent.labels).toContain('ai:human-needed');
  expect((await scan(deps))[0]?.mode).toBe('release');
  await apply(deps, cap!);
  expect(parent.state).toBe('open');
  expect(
    (await inspect(deps, 12)).comments.filter((c) =>
      findMarkers(c.body, 'review').some(
        (m) => m.attrs.kind === 'cap' && m.attrs.hash === cap!.hash,
      ),
    ),
  ).toHaveLength(1);
  const writes = state.writes.length;
  expect(await scan(deps)).toEqual([]);
  await apply(deps, cap!);
  await apply(
    deps,
    { ...cap!, mode: 'review' },
    JSON.stringify([proposed('forbidden-fourth-gap')]),
  );
  expect(state.writes).toHaveLength(writes);
  parent.body += '\nNew scope resets the rounds';
  const [edited] = await scan(deps);
  expect(edited).toMatchObject({ mode: 'analyze', review_rounds: 0 });
  await apply(deps, edited!, JSON.stringify([proposed('new-scope')]));
  expect((await inspect(deps, 12)).state).toMatchObject({
    review_rounds: 0,
    reviewed_hash: '',
  });
  closeTasks();
  expect((await scan(deps))[0]).toMatchObject({
    mode: 'review',
    review_rounds: 0,
  });
});
it('full lifecycle: creates four linked tasks, releases three, releases the fourth after a blocker closes, and reviews [] to completion', async () => {
  const { deps, state, appClient, userClient, parent } = requirementsSetup();
  const [analysis] = await scan(deps);
  expect(analysis?.mode).toBe('analyze');
  expect(await apply(deps, analysis!, four)).toBe(0);
  let view = await inspect(deps, 12);
  expect(view.tasks).toHaveLength(4);
  expect(
    view.tasks.filter((t) => t.assignedToCopilot).map((t) => t.id),
  ).toEqual(['a', 'b', 'c']);
  expect(state.subIssues.get(`${repo}#12`)).toHaveLength(4);
  const a = view.tasks.find((t) => t.id === 'a')!;
  const d = view.tasks.find((t) => t.id === 'd')!;
  expect(state.blockedBy.get(`${repo}#${d.issueNumber}`)).toEqual([a.issueId]);
  expect(a.issueId).not.toBe(a.issueNumber);
  expect(userClient.writes.map((w) => w.method)).toEqual([
    'assignCopilot',
    'assignCopilot',
    'assignCopilot',
  ]);
  expect(appClient.writes.some((w) => w.method === 'assignCopilot')).toBe(
    false,
  );
  expect(JSON.stringify(userClient.writes[0])).toContain(
    'This task is part of requirements #12. Only do this task.',
  );
  const writes = state.writes.length;
  await apply(deps, analysis!, four);
  expect(await scan(deps)).toEqual([]);
  expect(state.writes).toHaveLength(writes);
  state.issues.get(`${repo}#${a.issueNumber}`)!.state = 'closed';
  const [release] = await scan(deps);
  expect(release?.mode).toBe('release');
  await apply(deps, release!);
  view = await inspect(deps, 12);
  expect(view.tasks.find((t) => t.id === 'd')?.assignedToCopilot).toBe(true);
  expect(userClient.writes).toHaveLength(4);
  for (const t of view.tasks)
    state.issues.get(`${repo}#${t.issueNumber}`)!.state = 'closed';
  const [review] = await scan(deps);
  expect(review?.mode).toBe('review');
  await apply(deps, review!, '[]');
  expect(parent.state).toBe('closed');
  expect(
    state.comments
      .get(`${repo}#12`)
      ?.filter((c) => findMarkers(c.body, 'req-state').length),
  ).toHaveLength(1);
  expect(
    state.comments
      .get(`${repo}#12`)
      ?.filter((c) => c.body.startsWith('**All requirements implemented.**')),
  ).toHaveLength(1);
  const finalWrites = state.writes.length;
  await apply(deps, review!, '[]');
  expect(await scan(deps)).toEqual([]);
  expect(state.writes).toHaveLength(finalWrites);
});
it.each(['createIssue', 'addSubIssue', 'addBlockedBy'] as const)(
  'resumes after %s failure without duplicate issues or incomplete dependencies',
  async (method) => {
    const { deps, appClient, state } = requirementsSetup();
    const [snapshot] = await scan(deps);
    const original = appClient[method].bind(appClient);
    let count = 0;
    // Fail after at least one successful creation; the failure can leave an orphan.
    const spy = vi.spyOn(appClient, method);
    spy.mockImplementation((async (...args: unknown[]) => {
      if (++count === (method === 'createIssue' ? 2 : 1))
        throw new Error('interrupted');
      return (original as (...args: unknown[]) => Promise<unknown>)(...args);
    }) as (typeof appClient)[typeof method]);
    await expect(apply(deps, snapshot!, four)).rejects.toThrow('interrupted');
    expect((await inspect(deps, 12)).state).toBeNull();
    spy.mockRestore();
    await apply(deps, snapshot!, four);
    expect(
      [...state.issues.values()].filter(
        (i) => findMarkers(i.body ?? '', 'task').length,
      ),
    ).toHaveLength(4);
    const view = await inspect(deps, 12);
    expect(view.tasks).toHaveLength(4);
    expect(view.tasks.find((t) => t.id === 'd')?.blockedBy).toHaveLength(1);
  },
);
it('a fresh scan includes orphaned tasks and repairs their links without repeating ids', async () => {
  const { deps, appClient } = requirementsSetup();
  const [snapshot] = await scan(deps);
  await interruptNewLink(appClient);
  await expect(
    apply(deps, snapshot!, JSON.stringify([proposed('a')])),
  ).rejects.toThrow();
  const [next] = await scan(deps);
  await apply(deps, next!, JSON.stringify([proposed('b', ['a'])]));
  expect((await inspect(deps, 12)).tasks.map((t) => t.id)).toEqual(['a', 'b']);
});
it('an edited body analyzes again, rejects an existing-id clash once per hash, and creates only new ids', async () => {
  const { deps, parent, state } = requirementsSetup();
  await apply(deps, (await scan(deps))[0]!, four);
  parent.body += '\nAdd another feature';
  const [edited] = await scan(deps);
  expect(edited?.mode).toBe('analyze');
  expect(await apply(deps, edited!, JSON.stringify([proposed('a')]))).toBe(1);
  const writes = state.writes.length;
  expect(await apply(deps, edited!, JSON.stringify([proposed('a')]))).toBe(1);
  expect(state.writes).toHaveLength(writes);
  await apply(deps, edited!, JSON.stringify([proposed('e', ['a'])]));
  expect((await inspect(deps, 12)).tasks).toHaveLength(5);
});
it('rejects stale model output after an edit or label removal without writes', async () => {
  const { deps, parent, state } = requirementsSetup();
  const [snapshot] = await scan(deps);
  parent.body = 'new';
  await apply(deps, snapshot!, four);
  expect(state.writes).toEqual([]);
  const [next] = await scan(deps);
  parent.labels = [];
  await apply(deps, next!, four);
  expect(state.writes).toEqual([]);
});
it('recovers label failure after assignment without a second assignment', async () => {
  const { deps, appClient, userClient } = requirementsSetup();
  const [snapshot] = await scan(deps);
  vi.spyOn(appClient, 'addLabels').mockRejectedValueOnce(
    new Error('interrupted'),
  );
  await expect(apply(deps, snapshot!, four)).rejects.toThrow();
  await apply(deps, snapshot!, four);
  expect(userClient.writes).toHaveLength(3);
  const view = await inspect(deps, 12);
  expect(
    view.known.filter((i) => i.labels.includes('ai:in-progress')),
  ).toHaveLength(3);
});
it('recovers failed closure from a durable completion receipt', async () => {
  const { deps, appClient, state, parent } = requirementsSetup();
  await apply(deps, (await scan(deps))[0]!, four);
  for (const i of state.issues.values())
    if (i.number !== 12) i.state = 'closed';
  const [review] = await scan(deps);
  vi.spyOn(appClient, 'closeIssue').mockRejectedValueOnce(
    new Error('interrupted'),
  );
  await expect(apply(deps, review!, '[]')).rejects.toThrow();
  expect((await scan(deps))[0]?.mode).toBe('review');
  await apply(deps, review!, '[]');
  expect(parent.state).toBe('closed');
  expect(
    state.comments
      .get(`${repo}#12`)
      ?.filter((c) =>
        findMarkers(c.body, 'review').some((m) => m.attrs.kind === 'complete'),
      ),
  ).toHaveLength(1);
});
it('resumes a gap round exactly once, then a second empty review closes the requirements', async () => {
  const { deps, appClient, state, parent } = requirementsSetup();
  await apply(deps, (await scan(deps))[0]!, four);
  for (const i of state.issues.values())
    if (i.number !== 12) i.state = 'closed';
  const [review] = await scan(deps);
  await interruptNewLink(appClient);
  const raw = JSON.stringify([proposed('gap'), proposed('gap-two', ['gap'])]);
  await expect(apply(deps, review!, raw)).rejects.toThrow();
  expect((await scan(deps))[0]?.mode).toBe('review');
  await apply(deps, review!, raw);
  const view = await inspect(deps, 12);
  expect(view.state?.reviewed_hash).toBe('');
  expect(view.state?.review_rounds).toBe(1);
  const writes = state.writes.length;
  await apply(deps, review!, raw);
  expect(state.writes).toHaveLength(writes);
  expect((await inspect(deps, 12)).state?.review_rounds).toBe(1);
  for (const i of state.issues.values())
    if (i.number !== 12) i.state = 'closed';
  const [nextReview] = await scan(deps);
  expect(nextReview?.mode).toBe('review');
  expect(nextReview?.review_rounds).toBe(1);
  // An old round's artifact cannot consume or complete the next round.
  await apply(deps, review!, raw);
  expect(parent.state).toBe('open');
  await apply(deps, nextReview!, '[]');
  expect(await scan(deps)).toEqual([]);
  expect(parent.state).toBe('closed');
  expect((await inspect(deps, 12)).state?.reviewed_hash).toBe(view.hash);
});
it('a fresh scheduled run repairs the last assignment label/table even when all slots are occupied', async () => {
  const { deps, appClient, userClient, state } = requirementsSetup();
  const add = appClient.addLabels.bind(appClient);
  let count = 0;
  vi.spyOn(appClient, 'addLabels').mockImplementation(async (...args) => {
    if (++count === 3) throw new Error('interrupted');
    await add(...args);
  });
  await expect(apply(deps, (await scan(deps))[0]!, four)).rejects.toThrow();
  expect(userClient.writes).toHaveLength(3);
  const [repair] = await scan(deps);
  expect(repair?.mode).toBe('release');
  await apply(deps, repair!);
  expect(userClient.writes).toHaveLength(3);
  expect(
    [...state.issues.values()].filter((i) =>
      i.labels.includes('ai:in-progress'),
    ),
  ).toHaveLength(3);
  expect(await scan(deps)).toEqual([]);
});
it('an empty resumed review does not close a parent with already-created open gap tasks', async () => {
  const { deps, appClient, state, parent } = requirementsSetup();
  await apply(deps, (await scan(deps))[0]!, four);
  for (const i of state.issues.values())
    if (i.number !== 12) i.state = 'closed';
  const [review] = await scan(deps);
  await interruptNewLink(appClient);
  await expect(
    apply(deps, review!, JSON.stringify([proposed('gap')])),
  ).rejects.toThrow();
  const [resumed] = await scan(deps);
  await apply(deps, resumed!, '[]');
  expect(parent.state).toBe('open');
  expect((await inspect(deps, 12)).state?.review_rounds).toBe(1);
  expect((await inspect(deps, 12)).state?.reviewed_hash).toBe('');
  expect(
    (await inspect(deps, 12)).tasks.find((t) => t.id === 'gap')
      ?.assignedToCopilot,
  ).toBe(true);
});
it('honors supported triggers, optional manual issue selection, disabled config, and App attribution', async () => {
  const { deps, parent, state } = requirementsSetup();
  deps.event = { name: 'issues', action: 'opened', issue: parent, repo };
  expect(await scan(deps)).toEqual([]);
  deps.event = {
    name: 'issues',
    action: 'labeled',
    label: 'other',
    issue: parent,
    repo,
  };
  expect(await scan(deps)).toEqual([]);
  deps.event = { name: 'issues', action: 'edited', issue: parent, repo };
  expect((await scan(deps))[0]?.mode).toBe('analyze');
  deps.event = { name: 'workflow_dispatch', inputs: { issue: '12' }, repo };
  expect(await scan(deps)).toHaveLength(1);
  deps.event.inputs.issue = 'not-a-number';
  await expect(scan(deps)).rejects.toThrow('positive integer');
  deps.event.inputs.issue = '';
  state.comments.set(`${repo}#12`, [
    {
      id: 1,
      body: '<!-- ai-factory:req-state {} -->',
      user: { login: 'attacker', type: 'User' },
    },
  ]);
  expect((await scan(deps))[0]?.mode).toBe('analyze');
  deps.config.requirements.enabled = false;
  expect(await scan(deps)).toEqual([]);
});
it('replaying a committed review repairs an interrupted gap assignment', async () => {
  const { deps, userClient, state } = requirementsSetup();
  await apply(deps, (await scan(deps))[0]!, four);
  for (const i of state.issues.values())
    if (i.number !== 12) i.state = 'closed';
  const [review] = await scan(deps);
  vi.spyOn(userClient, 'assignCopilot').mockRejectedValueOnce(
    new Error('interrupted'),
  );
  const raw = JSON.stringify([proposed('gap')]);
  await expect(apply(deps, review!, raw)).rejects.toThrow();
  await apply(deps, review!, raw);
  expect(
    (await inspect(deps, 12)).tasks.find((t) => t.id === 'gap')
      ?.assignedToCopilot,
  ).toBe(true);
});
it('a failed gap-round state write increments the counter only once on retry', async () => {
  const { deps, appClient, state } = requirementsSetup();
  await apply(deps, (await scan(deps))[0]!, four);
  for (const i of state.issues.values())
    if (i.number !== 12) i.state = 'closed';
  const [review] = await scan(deps);
  const raw = JSON.stringify([proposed('gap')]);
  vi.spyOn(appClient, 'updateComment').mockRejectedValueOnce(
    new Error('interrupted state write'),
  );
  await expect(apply(deps, review!, raw)).rejects.toThrow('interrupted');
  expect((await inspect(deps, 12)).state?.review_rounds).toBe(0);
  await apply(deps, review!, raw);
  const writes = state.writes.length;
  await apply(deps, review!, raw);
  expect((await inspect(deps, 12)).state?.review_rounds).toBe(1);
  expect(state.writes).toHaveLength(writes);
});
it('does not advance the parent hash or release tasks if requirements change during creation', async () => {
  const { deps, appClient, userClient, parent } = requirementsSetup();
  const [snapshot] = await scan(deps);
  const create = appClient.createIssue.bind(appClient);
  vi.spyOn(appClient, 'createIssue').mockImplementation(async (...args) => {
    const issue = await create(...args);
    parent.body = 'Changed while apply was running';
    return issue;
  });
  await apply(deps, snapshot!, JSON.stringify([proposed('a')]));
  expect((await inspect(deps, 12)).state).toBeNull();
  expect(userClient.writes).toEqual([]);
  expect((await scan(deps))[0]?.mode).toBe('analyze');
});
