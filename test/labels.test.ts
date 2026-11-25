import { expect, it } from 'vitest';
import { fixAttemptOf, LABELS } from '../src/labels.js';

it('defines unique complete factory labels with GitHub colors and descriptions', () => {
  expect(LABELS).toHaveLength(19);
  expect(new Set(LABELS.map((v) => v.name)).size).toBe(LABELS.length);
  for (const label of LABELS) {
    expect(label.color).toMatch(/^[0-9a-f]{6}$/i);
    expect(label.description.length).toBeGreaterThan(0);
  }
});
it('returns the highest valid repair counter, ignoring unrelated or malformed labels', () => {
  expect(fixAttemptOf([])).toBe(0);
  expect(fixAttemptOf(['ai:manual', 'ai:fix-1', 'ai:fix-10', 'ai:fix-3'])).toBe(
    10,
  );
  expect(
    fixAttemptOf(['ai:fix-0', 'ai:fix-11', 'ai:fix-2x', 'ai:fix-01']),
  ).toBe(0);
});
