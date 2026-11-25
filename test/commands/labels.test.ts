import { describe, expect, it } from 'vitest';
import { run } from '../../src/commands/labels.js';
import { LABELS } from '../../src/labels.js';
import { repo, setup } from '../helpers.js';

describe('labels command', () => {
  it('creates missing, updates changed, preserves unchanged, and prints statuses', async () => {
    const { deps, state, logs, userClient } = setup();
    state.labels.set(repo, [
      { ...LABELS[0]!, color: '000000' },
      { ...LABELS[1]!, color: LABELS[1]!.color.toUpperCase() },
      { ...LABELS[2]!, description: 'outdated' },
      { name: 'unrelated', color: '123456', description: 'Keep me' },
    ]);
    await run(deps);
    expect(state.writes.filter((v) => v.method === 'updateLabel')).toHaveLength(
      2,
    );
    expect(state.writes.filter((v) => v.method === 'createLabel')).toHaveLength(
      LABELS.length - 3,
    );
    expect(logs).toContain(`${LABELS[0]!.name}\tupdated`);
    expect(logs).toContain(`${LABELS[1]!.name}\tunchanged`);
    expect(logs).toContain(`${LABELS[3]!.name}\tcreated`);
    expect(
      state.labels.get(repo)?.find((label) => label.name === 'unrelated'),
    ).toBeDefined();
    const count = state.writes.length;
    await run(deps);
    expect(state.writes).toHaveLength(count);
    expect(userClient.writes).toEqual([]);
  });
});
