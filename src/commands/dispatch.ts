import { assignToCopilot, buildInstructions } from '../copilot.js';
import { planGateApplies, shouldDispatch } from '../filters.js';
import { findMarkers, marker } from '../markers.js';
import { notice, type Dependencies } from './types.js';
import { run as post } from './post.js';
import {
  factoryComments,
  hasSource,
  routeOutput,
  sourceOf,
  type RouteOutput,
} from './state.js';

export async function run({
  event,
  appClient,
  userClient,
  config,
  log,
}: Dependencies): Promise<RouteOutput> {
  const done = routeOutput(event);
  if (
    event.name !== 'issues' ||
    (event.action !== 'opened' &&
      !(event.action === 'labeled' && event.label === config.labels.needs_plan))
  ) {
    notice(log, 'unsupported dispatch trigger');
    return done;
  }
  // Webhook payloads are snapshots: fetch current state before making any writes.
  const issue = await appClient.getIssue(event.repo, event.issue.number);
  const decision = shouldDispatch(issue, config);
  if (!decision.ok) {
    notice(log, decision.reason);
    return done;
  }
  const comments = await appClient.listIssueComments(event.repo, issue.number);
  const hasState = (state: string) =>
    comments.some(({ body }) =>
      findMarkers(body, 'dispatch').some((m) => m.attrs.state === state),
    );
  if (planGateApplies(issue, config)) {
    if (
      factoryComments(comments, event).some((c) =>
        hasSource(c, 'plan', sourceOf(event)),
      )
    ) {
      await post(
        { event, appClient, userClient, config, log },
        { mode: 'plan' },
      );
      return done;
    }
    return routeOutput(event, 'plan');
  }
  // A completion marker also protects against reassignment after someone removes the assignee.
  if (hasState('assigned')) {
    notice(log, 'already-dispatched');
    return done;
  }
  await assignToCopilot(userClient, {
    repo: event.repo,
    issue: issue.number,
    baseBranch: config.base_branch,
    customAgent: config.agents.implementer,
    model: config.model,
    instructions: buildInstructions({ issueUrl: issue.html_url }),
  });
  if (!issue.labels.includes('ai:in-progress'))
    await appClient.addLabels(event.repo, issue.number, ['ai:in-progress']);
  await appClient.createComment(
    event.repo,
    issue.number,
    `**Assigned to Copilot.** Follow progress in the linked pull request.\n\n${marker('dispatch', { state: 'assigned' })}`,
  );
  return done;
}
