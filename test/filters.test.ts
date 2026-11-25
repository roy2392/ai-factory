import { describe, expect, it } from 'vitest';
import { planGateApplies, shouldDispatch } from '../src/filters.js';
import type { Issue } from '../src/github/client.js';
import { repo, setup, skipCases } from './helpers.js';

describe('dispatch filters', () => {
  it('accepts a trusted open issue', () => {
    const { state, deps } = setup();
    expect(
      shouldDispatch(state.issues.get(`${repo}#12`)!, deps.config),
    ).toEqual({ ok: true });
  });
  it.each(skipCases)(
    'skips %s ahead of lower-priority reasons',
    (reason, overrides) => {
      const { state, deps } = setup();
      const index = skipCases.findIndex(([name]) => name === reason);
      const lower = Object.assign(
        {},
        ...skipCases.slice(index + 1).map(([, patch]) => patch),
      ) as Partial<Issue>;
      const issue = {
        ...state.issues.get(`${repo}#12`)!,
        ...lower,
        ...overrides,
      };
      expect(shouldDispatch(issue, deps.config)).toEqual({ ok: false, reason });
    },
  );
  it.each([
    null,
    { login: 'other[bot]', type: 'User' },
    { login: 'copilot-swe-agent', type: 'User' },
  ])('rejects bot or missing authors %j', (user) => {
    const { state, deps } = setup();
    expect(
      shouldDispatch({ ...state.issues.get(`${repo}#12`)!, user }, deps.config),
    ).toEqual({ ok: false, reason: 'bot-author' });
  });
  it.each(['always', 'never', 'label'] as const)(
    'evaluates %s with and without the configured label',
    (mode) => {
      const { state, deps } = setup();
      deps.config.plan_gate = mode;
      deps.config.labels.needs_plan = 'design';
      const issue = state.issues.get(`${repo}#12`)!;
      expect(planGateApplies(issue, deps.config)).toBe(mode === 'always');
      issue.labels = ['design'];
      expect(planGateApplies(issue, deps.config)).toBe(mode !== 'never');
    },
  );
});
