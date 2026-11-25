import type { Issue } from '../github/client.js';
import { findMarkers } from '../markers.js';
import { isCopilot } from '../copilot.js';

export interface Task {
  id: string;
  issueNumber: number;
  issueId: number;
  state: 'open' | 'closed';
  assignedToCopilot: boolean;
  blockedBy: number[];
}
export function taskId(issue: Issue, parent: number): string | null {
  const markers = findMarkers(issue.body ?? '', 'task');
  if (markers.length !== 1) return null;
  const m = markers[0]!;
  return m.attrs.req === String(parent) &&
    /^[a-z0-9-]{1,40}$/.test(m.attrs.id ?? '')
    ? m.attrs.id!
    : null;
}
export function loadTasks(
  subIssues: Issue[],
  blockedByMap: Map<number, number[]>,
  parent: number,
): Task[] {
  return subIssues.flatMap((issue) => {
    const id = taskId(issue, parent);
    if (!id) return [];
    if (!issue.id) throw new Error('Task issue is missing its database id');
    return [
      {
        id,
        issueNumber: issue.number,
        issueId: issue.id,
        state: issue.state,
        assignedToCopilot: issue.assignees.some((a) => isCopilot(a.login)),
        blockedBy: blockedByMap.get(issue.number) ?? [],
      },
    ];
  });
}
