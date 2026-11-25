import { expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { decideMode } from '../../src/requirements/mode.js';
import { hashBody } from '../../src/requirements/state.js';
import { task } from './helpers.js';
const hash = hashBody('requirements');
const state = {
  version: 1 as const,
  hash,
  reviewed_hash: '',
  review_rounds: 0,
  last_run: '',
};
const base = {
  state,
  bodyHash: hash,
  tasks: [task('a', 1)],
  config: DEFAULT_CONFIG,
};
it('selects every mode and gives edited requirements precedence over release', () => {
  expect(decideMode({ ...base, state: null })).toBe('analyze');
  expect(decideMode({ ...base, bodyHash: hashBody('edit') })).toBe('analyze');
  expect(decideMode(base)).toBe('release');
  expect(
    decideMode({ ...base, tasks: [task('a', 1, { state: 'closed' })] }),
  ).toBe('review');
  expect(decideMode({ ...base, tasks: [] })).toBe('review');
  expect(
    decideMode({
      ...base,
      state: { ...state, reviewed_hash: hash },
      tasks: [task('a', 1, { state: 'closed' })],
    }),
  ).toBe('idle');
});
it('allows zero-task review below the cap, stops at three rounds, and lets edits reset the lifecycle', () => {
  for (const tasks of [[], [task('a', 1, { state: 'closed' })]]) {
    expect(
      decideMode({ ...base, tasks, state: { ...state, review_rounds: 2 } }),
    ).toBe('review');
    expect(
      decideMode({ ...base, tasks, state: { ...state, review_rounds: 3 } }),
    ).toBe('idle');
    expect(
      decideMode({
        ...base,
        tasks,
        state: { ...state, review_rounds: 3 },
        bodyHash: hashBody('edited'),
      }),
    ).toBe('analyze');
  }
  expect(decideMode({ ...base, state: { ...state, review_rounds: 3 } })).toBe(
    'release',
  );
  expect(
    decideMode({
      ...base,
      tasks: [],
      state: { ...state, reviewed_hash: hash },
    }),
  ).toBe('idle');
});
it('respects max_open and disabled requirements', () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.requirements.max_open = 1;
  expect(
    decideMode({
      ...base,
      config,
      tasks: [task('a', 1, { assignedToCopilot: true }), task('b', 2)],
    }),
  ).toBe('idle');
  config.requirements.enabled = false;
  expect(decideMode({ ...base, config, state: null })).toBe('idle');
});
