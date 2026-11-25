import type { FactoryConfig } from './config.js';
import type { Issue } from './github/client.js';
import { isCopilot } from './copilot.js';
import { findMarkers } from './markers.js';

export type Decision = { ok: true } | { ok: false; reason: string };
export function shouldDispatch(issue: Issue, config: FactoryConfig): Decision {
  const skip = (reason: string): Decision => ({ ok: false, reason });
  if (issue.state !== 'open') return skip('closed');
  if (issue.pull_request) return skip('pull-request');
  if (
    !issue.user ||
    issue.user.type === 'Bot' ||
    /\[bot\]$/i.test(issue.user.login) ||
    isCopilot(issue.user.login)
  )
    return skip('bot-author');
  if (
    !config.allowed_associations.some(
      (association) => association === issue.author_association,
    )
  )
    return skip('association');
  const skipLabel = config.labels.skip.find((label) =>
    issue.labels.includes(label),
  );
  if (skipLabel) return skip(`skip-label:${skipLabel}`);
  if (issue.assignees.some(({ login }) => isCopilot(login)))
    return skip('already-assigned');
  if (findMarkers(issue.body ?? '', 'task').length) return skip('task-issue');
  return { ok: true };
}

export function planGateApplies(issue: Issue, config: FactoryConfig): boolean {
  return (
    config.plan_gate === 'always' ||
    (config.plan_gate === 'label' &&
      issue.labels.includes(config.labels.needs_plan))
  );
}
