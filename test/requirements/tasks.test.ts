import { expect, it } from 'vitest';
import { loadTasks } from '../../src/requirements/tasks.js';
import { requirementsSetup } from './helpers.js';
it('loads only matching task markers and retains blocker database ids and Copilot assignment', () => {
  const { parent } = requirementsSetup();
  const issue = {
    ...parent,
    id: 7001,
    number: 13,
    assignees: [{ login: 'Copilot' }],
    body: '<!-- ai-factory:task req=12 id=a -->',
  };
  const tasks = loadTasks(
    [
      issue,
      { ...issue, body: '<!-- ai-factory:task req=99 id=foreign -->' },
      { ...issue, body: 'human sub-issue' },
    ],
    new Map([[13, [7000]]]),
    12,
  );
  expect(tasks).toEqual([
    {
      id: 'a',
      issueNumber: 13,
      issueId: 7001,
      state: 'open',
      assignedToCopilot: true,
      blockedBy: [7000],
    },
  ]);
});
