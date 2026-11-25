import { describe, expect, it } from 'vitest';
import { run } from '../../src/commands/dispatch.js';
import { marker } from '../../src/markers.js';
import { repo, setup, skipCases } from '../helpers.js';

describe('dispatch command', () => {
  it('writes exactly assign (user), label and comment (App), then skips a stale-event rerun', async () => {
    const { deps, state, logs } = setup();
    await run(deps);
    expect(
      state.writes.map(({ method, identity }) => [method, identity]),
    ).toEqual([
      ['assignCopilot', 'user'],
      ['addLabels', 'app'],
      ['createComment', 'app'],
    ]);
    expect(state.comments.get(`${repo}#12`)?.[0]?.body).toBe(
      `**Assigned to Copilot.** Follow progress in the linked pull request.\n\n${marker('dispatch', { state: 'assigned' })}`,
    );
    await run(deps);
    expect(state.writes).toHaveLength(3);
    expect(logs).toContain('::notice::already-assigned');
  });
  it('does not duplicate completed dispatch after the assignee is removed', async () => {
    const { deps, state, logs } = setup();
    state.comments.set(`${repo}#12`, [
      { id: 1, body: marker('dispatch', { state: 'assigned' }) },
    ]);
    await run(deps);
    expect(state.writes).toEqual([]);
    expect(logs).toContain('::notice::already-dispatched');
  });
  it('routes the plan gate without writes and stops once that request has a published plan', async () => {
    const { deps, state } = setup();
    state.issues.get(`${repo}#12`)!.labels = ['ai:needs-plan'];
    expect(await run(deps)).toEqual({ mode: 'plan', issue: 12, comment_id: 0 });
    expect(state.writes).toHaveLength(0);
    state.comments.set(`${repo}#12`, [
      {
        id: 1,
        body: marker('plan', { source: 'issue-12' }),
        user: { login: 'ai-factory[bot]', type: 'Bot' },
      },
    ]);
    expect((await run(deps)).mode).toBe('done');
  });
  it.each(skipCases)('writes nothing for %s', async (reason, patch) => {
    const { deps, state, logs } = setup();
    Object.assign(state.issues.get(`${repo}#12`)!, patch);
    await run(deps);
    expect(state.writes).toEqual([]);
    expect(logs).toContain(`::notice::${reason}`);
  });
  it('handles labeled only for the configured needs-plan label', async () => {
    const { deps, state } = setup();
    if (deps.event.name !== 'issues') throw new Error('Expected fixture issue');
    deps.event.action = 'labeled';
    deps.event.label = 'other';
    await run(deps);
    expect(state.writes).toHaveLength(0);
    deps.event.label = 'design';
    deps.config.labels.needs_plan = 'design';
    state.issues.get(`${repo}#12`)!.labels = ['design'];
    expect((await run(deps)).mode).toBe('plan');
    expect(state.writes).toHaveLength(0);
  });
  it('skips unsupported events/actions and keeps preexisting labels', async () => {
    const { deps, state } = setup();
    if (deps.event.name !== 'issues') throw new Error('Expected fixture issue');
    deps.event.action = 'edited';
    await run(deps);
    expect(state.writes).toHaveLength(0);
    deps.event.action = 'opened';
    state.issues.get(`${repo}#12`)!.labels = ['ai:in-progress'];
    await run(deps);
    expect(state.writes.map((call) => call.method)).toEqual([
      'assignCopilot',
      'createComment',
    ]);
    const other = setup('pull_request_target');
    await run(other.deps);
    expect(other.state.writes).toHaveLength(0);
  });
});
