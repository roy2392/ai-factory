import type { Task } from '../../src/requirements/tasks.js';
import type { ProposedTask } from '../../src/requirements/validate.js';
import { setup, repo } from '../helpers.js';
export function task(id: string, n: number, extra: Partial<Task> = {}): Task {
  return {
    id,
    issueNumber: n,
    issueId: n + 1000,
    state: 'open',
    assignedToCopilot: false,
    blockedBy: [],
    ...extra,
  };
}
export function proposed(id = 'a', depends_on: string[] = []): ProposedTask {
  return {
    id,
    title: `Implement ${id}`,
    body: `Implement ${id}.\n\n## Acceptance criteria\n- Tests pass.`,
    depends_on,
  };
}
export function requirementsSetup() {
  const context = setup();
  const parent = context.state.issues.get(`${repo}#12`)!;
  parent.id = 1012;
  parent.title = 'Requirements';
  parent.body = 'Build four related features';
  parent.labels = ['requirements'];
  context.deps.event = {
    name: 'schedule',
    schedule: '0 * * * *',
    repo,
    factoryLogin: 'ai-factory[bot]',
    runUrl: 'https://github.com/acme/widget/actions/runs/42',
  };
  return { ...context, parent };
}
