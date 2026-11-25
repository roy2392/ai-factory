import { isCopilot } from '../copilot.js';
import { fixAttemptOf } from '../labels.js';
import { logTails, safeName } from '../logs.js';
import { findMarkers, marker } from '../markers.js';
import { capText } from '../text.js';
import type {
  Comment,
  GitHubClient,
  PullRequest,
  WorkflowRun,
} from '../github/client.js';
import { factoryComments } from './state.js';
import { notice, type Dependencies } from './types.js';

export function runSkipReason(run: WorkflowRun, repo: string): string | null {
  if (!['failure', 'timed_out'].includes(run.conclusion ?? ''))
    return 'conclusion';
  if (run.event !== 'pull_request') return 'not-pull-request';
  if (
    !run.head_repository ||
    run.head_repository.full_name.toLowerCase() !== repo.toLowerCase() ||
    run.repository.full_name.toLowerCase() !== repo.toLowerCase()
  )
    return 'fork';
  if (!run.head_branch) return 'missing-branch';
  return null;
}

function sameRepo(pr: PullRequest, repo: string): boolean {
  return (
    pr.base.repo.full_name.toLowerCase() === repo.toLowerCase() &&
    pr.head.repo?.full_name.toLowerCase() === repo.toLowerCase()
  );
}
function attempts(comments: Comment[]) {
  return comments.flatMap((c) => findMarkers(c.body, 'self-heal'));
}
async function syncAttempt(
  client: GitHubClient,
  repo: string,
  number: number,
  attempt: number,
): Promise<void> {
  const pr = await client.getPullRequest(repo, number);
  const latest = Math.max(attempt, fixAttemptOf(pr.labels));
  if (!pr.labels.includes(`ai:fix-${latest}`))
    await client.addLabels(repo, number, [`ai:fix-${latest}`]);
  for (const label of pr.labels)
    if (/^ai:fix-([1-9]|10)$/.test(label) && label !== `ai:fix-${latest}`)
      await client.removeLabel(repo, number, label);
}

export async function run({
  event,
  appClient,
  userClient,
  config,
  log,
}: Dependencies): Promise<void> {
  const skip = (reason: string) => notice(log, reason);
  if (event.name !== 'workflow_run' || event.action !== 'completed')
    return skip('unsupported self-heal trigger');
  const failed = event.workflowRun;
  const reason = runSkipReason(failed, event.repo);
  if (reason) return skip(reason);
  const prs = (
    await appClient.listPullRequestsForBranch(event.repo, failed.head_branch!)
  ).filter((pr) => pr.state === 'open' && sameRepo(pr, event.repo));
  if (!prs.length) return skip('no-open-pr');
  const copilot = prs.filter((pr) => pr.user && isCopilot(pr.user.login));
  if (!copilot.length) return skip('non-copilot-author');
  if (copilot.length !== 1) return skip('ambiguous-pr');
  const pr = await appClient.getPullRequest(event.repo, copilot[0]!.number);
  if (
    pr.state !== 'open' ||
    !sameRepo(pr, event.repo) ||
    !pr.user ||
    !isCopilot(pr.user.login)
  )
    return skip('pr-changed');
  if (!pr.head.sha || pr.head.sha !== failed.head_sha) return skip('stale-sha');
  if (!event.botLogin)
    throw new Error(
      'COPILOT_BOT_LOGIN is required for self-heal marker attribution',
    );
  const allComments = await appClient.listIssueComments(event.repo, pr.number);
  const trusted = [
    ...factoryComments(allComments, event),
    ...allComments.filter(
      (c) =>
        c.user?.type === 'User' &&
        c.user.login.toLowerCase() === event.botLogin!.toLowerCase(),
    ),
  ];
  const markers = attempts(trusted);
  const prior = markers.find((m) => m.attrs.run === String(failed.id));
  if (prior) {
    const attempt = Number(prior.attrs.attempt);
    if (prior.attrs.state === 'gave-up')
      await appClient.addLabels(event.repo, pr.number, ['ai:human-needed']);
    else if (Number.isInteger(attempt) && attempt >= 1 && attempt <= 10)
      await syncAttempt(appClient, event.repo, pr.number, attempt);
    return skip('duplicate-run');
  }
  const sentAttempts = markers
    .map((m) => Number(m.attrs.attempt))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 10);
  const attempt = Math.max(fixAttemptOf(pr.labels), 0, ...sentAttempts);
  if (attempt >= config.max_fix_attempts) {
    await appClient.addLabels(event.repo, pr.number, ['ai:human-needed']);
    // One escalation per exhausted cycle, even when more failing run IDs arrive.
    if (!markers.some((m) => m.attrs.state === 'gave-up')) {
      const mentions = config.escalate_to
        .filter((login) => /^[A-Za-z0-9-]+$/.test(login))
        .map((login) => `@${login}`)
        .join(' ');
      await appClient.createComment(
        event.repo,
        pr.number,
        `**Human help needed.**\n\nCopilot has reached the ${config.max_fix_attempts}-attempt repair limit. See run ${failed.html_url}.\n\n${capText(mentions, 40000, 40000)}\n\n${marker('self-heal', { run: String(failed.id), state: 'gave-up' })}`,
      );
    }
    return;
  }
  const jobs = (await appClient.listWorkflowJobs(event.repo, failed.id))
    .filter((job) => ['failure', 'timed_out'].includes(job.conclusion ?? ''))
    .slice(0, 3);
  const logs = await Promise.all(
    jobs.map(async (job) => ({
      name: job.name,
      log: await appClient.downloadJobLog(event.repo, job.id),
    })),
  );
  const current = await appClient.getPullRequest(event.repo, pr.number);
  if (
    current.state !== 'open' ||
    current.head.sha !== failed.head_sha ||
    !sameRepo(current, event.repo)
  )
    return skip('stale-sha');
  const next = attempt + 1;
  const tail =
    logTails(logs) || 'No failed job logs were available for this run.';
  const body = `**CI repair requested.**\n\n@copilot CI failed: ${safeName(failed.name)} / ${jobs.map((job) => safeName(job.name)).join(', ') || 'no failed jobs listed'} (attempt ${next} of ${config.max_fix_attempts}). Fix the cause, run the build and tests, and push. If the failure is not caused by this PR, say so and do not change code.\n\nRun: ${failed.html_url}\n\n<details><summary>Log tail</summary>\n\n\`\`\`text\n${tail}\n\`\`\`\n\n</details>\n\n${marker('self-heal', { run: String(failed.id), attempt: String(next) })}`;
  // Persist the run/attempt receipt before rotating labels. A retry repairs labels
  // from that receipt instead of incrementing again if a label write failed.
  await userClient.createComment(event.repo, pr.number, body);
  await syncAttempt(appClient, event.repo, pr.number, next);
}
