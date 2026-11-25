import { expect, it } from 'vitest';
import { selectReleasable } from '../../src/requirements/release.js';
import { task } from './helpers.js';
it('counts only open assigned tasks toward slots and orders eligible issues by number', () => {
  const tasks = [
    task('a', 10, { state: 'closed', assignedToCopilot: true }),
    task('b', 15),
    task('c', 12),
    task('d', 13, { assignedToCopilot: true }),
  ];
  expect(selectReleasable(tasks, 2).map((t) => t.id)).toEqual(['c']);
  expect(selectReleasable(tasks, 1)).toEqual([]);
});
it('requires all blockers to be known and closed, using database ids', () => {
  const tasks = [
    task('a', 10),
    task('b', 11, { blockedBy: [1010] }),
    task('c', 12, { blockedBy: [10] }),
  ];
  expect(selectReleasable(tasks, 3).map((t) => t.id)).toEqual(['a']);
  tasks[0]!.state = 'closed';
  expect(selectReleasable(tasks, 3).map((t) => t.id)).toEqual(['b']);
});
