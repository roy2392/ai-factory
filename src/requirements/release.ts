import type { Task } from './tasks.js';
export function selectReleasable(
  tasks: readonly Task[],
  maxOpen: number,
): Task[] {
  const slots = Math.max(
    0,
    maxOpen -
      tasks.filter((t) => t.state === 'open' && t.assignedToCopilot).length,
  );
  return tasks
    .filter(
      (t) =>
        t.state === 'open' &&
        !t.assignedToCopilot &&
        t.blockedBy.every((id) =>
          tasks.some((b) => b.issueId === id && b.state === 'closed'),
        ),
    )
    .sort((a, b) => a.issueNumber - b.issueNumber)
    .slice(0, slots);
}
