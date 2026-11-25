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
  it('posts the phase 1 gated placeholder only once without assignment or labels', async () => {
    const { deps, state } = setup();
    state.issues.get(`${repo}#12`)!.labels = ['ai:needs-plan'];
    await run(deps);
    await run(deps);
    expect(state.writes.map((call) => call.method)).toEqual(['createComment']);
    expect(state.comments.get(`${repo}#12`)?.[0]?.body).toBe(
      `**Plan gate:** waiting for phase 2\n\n${marker('dispatch', { state: 'gated' })}`,
    );
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
    await run(deps);
    expect(state.writes.map((call) => call.method)).toEqual(['createComment']);
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
