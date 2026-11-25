import { assignToCopilot, buildInstructions, isCopilot } from '../copilot.js';
import { findMarkers, marker } from '../markers.js';
import { parseAiCommand } from './parse.js';
import { run as post } from './post.js';
import {
  factoryComments,
  hasSource,
  routeOutput,
  sourceOf,
  type RouteOutput,
} from './state.js';
import { notice, type Dependencies } from './types.js';

export const HELP = `**AI Factory commands**

| Command | Action |
|---|---|
| \`/ai ask <question>\` | Answer using the repository and issue thread. |
| \`/ai do <instruction>\` | Assign implementation to Copilot. |
| \`/ai plan\` | Prepare a plan for review. |
| \`/ai go\` | Approve the latest plan and start implementation. |
| \`/ai stop\` | Remove Copilot and mark the issue manual; PRs remain open. |`;

export async function run({
  event,
  appClient,
  userClient,
  config,
  log,
}: Dependencies): Promise<RouteOutput> {
  const done = routeOutput(event);
  const skip = (reason: string) => {
    notice(log, reason);
    return done;
  };
  if (event.name !== 'issue_comment' || event.action !== 'created')
    return skip('unsupported ai-command trigger');
  if (event.issue.pull_request) return skip('pull-request');
  const { comment } = event;
  if (
    comment.user.type === 'Bot' ||
    /\[bot\]$/i.test(comment.user.login) ||
    isCopilot(comment.user.login) ||
    comment.user.login.toLowerCase() === event.botLogin?.toLowerCase()
  )
    return skip('bot-author');
  if (
    !config.allowed_associations.some(
      (value) => value === comment.author_association,
    )
  )
    return skip('association');
  const command = parseAiCommand(comment.body);
  if (!command) return skip('not-ai-command');
  const issue = await appClient.getIssue(event.repo, event.issue.number);
  if (issue.pull_request) return skip('pull-request');
  if (issue.state !== 'open' && command.cmd !== 'plan') return skip('closed');
  const source = sourceOf(event);
  const comments = factoryComments(
    await appClient.listIssueComments(event.repo, issue.number),
    event,
  );
  if (
    command.cmd === 'plan' &&
    comments.some((c) => hasSource(c, 'plan', source))
  ) {
    // A previous publisher may have posted the plan and failed while updating labels.
    await post({ event, appClient, userClient, config, log }, { mode: 'plan' });
    return skip('already-handled');
  }
  if (
    comments.some((c) =>
      ['dispatch', 'answer', 'plan'].some((kind) =>
        findMarkers(c.body, kind).some(
          (m) => m.attrs.source === source && m.attrs.state !== 'failed',
        ),
      ),
    )
  )
    return skip('already-handled');
  await appClient.addReaction(event.repo, comment.id, 'eyes');
  const reply = async (
    text: string,
    kind = 'answer',
    attrs: Record<string, string> = {},
  ) => {
    if (!comments.some((c) => hasSource(c, kind, source)))
      await appClient.createComment(
        event.repo,
        issue.number,
        `${text}\n\n${marker(kind, { cmd: command.cmd, source, ...attrs })}`,
      );
  };
  switch (command.cmd) {
    case 'ask':
    case 'plan':
      return routeOutput(event, command.cmd);
    case 'help':
      await reply(HELP);
      return done;
    case 'stop': {
      const assignees = issue.assignees
        .filter(({ login }) => isCopilot(login))
        .map(({ login }) => login);
      if (assignees.length)
        await userClient.removeAssignees(event.repo, issue.number, assignees);
      await appClient.addLabels(event.repo, issue.number, ['ai:manual']);
      await appClient.removeLabel(event.repo, issue.number, 'ai:in-progress');
      await reply(
        '**Automation stopped.** Copilot was unassigned and this issue is now manual. Existing PRs remain open.',
        'dispatch',
        { state: 'stopped' },
      );
      return done;
    }
    case 'do':
    case 'go': {
      let extra = command.arg;
      if (command.cmd === 'go') {
        const plan = [...comments]
          .sort((a, b) => b.id - a.id)
          .find((c) =>
            findMarkers(c.body, 'plan').some((m) => m.attrs.state !== 'failed'),
          );
        if (
          (!issue.labels.includes('ai:plan-ready') &&
            !issue.labels.includes('ai:needs-info')) ||
          !plan
        ) {
          await reply('**No plan to approve.** Use `/ai plan` first.');
          return done;
        }
        extra = plan.body;
      }
      if (issue.assignees.some(({ login }) => isCopilot(login))) {
        await reply(
          '**Copilot is already working.** Use `@copilot` on the linked PR to request changes.',
        );
        return done;
      }
      const url =
        comment.html_url ?? `${issue.html_url}#issuecomment-${comment.id}`;
      await assignToCopilot(userClient, {
        repo: event.repo,
        issue: issue.number,
        baseBranch: config.base_branch,
        customAgent: config.agents.implementer,
        model: config.model,
        instructions: buildInstructions({
          issueUrl: issue.html_url,
          extra: `Requested by @${comment.user.login} in ${url}\n\n${extra}`,
        }),
      });
      if (command.cmd === 'go')
        for (const label of new Set([
          'ai:needs-plan',
          config.labels.needs_plan,
          'ai:plan-ready',
          'ai:needs-info',
        ]))
          await appClient.removeLabel(event.repo, issue.number, label);
      await appClient.addLabels(event.repo, issue.number, ['ai:in-progress']);
      await reply(
        '**Assigned to Copilot.** Follow progress in the linked pull request.',
        'dispatch',
        { state: 'assigned' },
      );
      return done;
    }
  }
}
