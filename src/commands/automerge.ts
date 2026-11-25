import { isCopilot } from '../copilot.js';
import { notice, type Dependencies } from './types.js';

import { linkedIssues } from '../links.js';
export { linkedIssues } from '../links.js';

export async function run({
  event,
  appClient,
  config,
  log,
}: Dependencies): Promise<void> {
  if (
    event.name !== 'pull_request_target' ||
    !['opened', 'ready_for_review', 'reopened'].includes(event.action)
  ) {
    notice(log, 'unsupported automerge trigger');
    return;
  }
  const pr = await appClient.getPullRequest(
    event.repo,
    event.pullRequest.number,
  );
  if (!pr.user || !isCopilot(pr.user.login)) {
    notice(log, 'non-copilot-author');
    return;
  }
  if (pr.state !== 'open') {
    notice(log, 'closed');
    return;
  }
  if (
    !pr.head.repo ||
    pr.head.repo.full_name.toLowerCase() !==
      pr.base.repo.full_name.toLowerCase() ||
    pr.base.repo.full_name.toLowerCase() !== event.repo.toLowerCase()
  ) {
    notice(log, 'fork');
    return;
  }
  if (pr.draft) {
    notice(log, 'draft');
    return;
  }
  if (pr.base.ref !== config.base_branch) {
    notice(log, 'base-branch');
    return;
  }

  const users = new Set<string>();
  const teams = new Set<string>();
  const reviewInitialized = pr.labels.includes('ai:awaiting-review');
  for (const reviewer of reviewInitialized ? [] : config.reviewers) {
    if (reviewer.includes('/')) {
      const [org, team, ...rest] = reviewer.split('/');
      if (
        !org ||
        !team ||
        rest.length ||
        org.toLowerCase() !== event.repo.split('/')[0]!.toLowerCase()
      )
        throw new Error(
          'Review teams must be org/team in the target repository owner',
        );
      if (
        !pr.requested_teams.some(
          ({ slug }) => slug.toLowerCase() === team.toLowerCase(),
        )
      )
        teams.add(team.toLowerCase());
    } else if (!isCopilot(reviewer) && !/\[bot\]$/i.test(reviewer)) {
      // The licensed bot is a normal User, indistinguishable from a human via its account type.
      if (!event.botLogin)
        throw new Error(
          'COPILOT_BOT_LOGIN is required when user reviewers are configured',
        );
      if (
        reviewer.toLowerCase() !== event.botLogin.toLowerCase() &&
        !pr.requested_reviewers.some(
          ({ login }) => login.toLowerCase() === reviewer.toLowerCase(),
        )
      )
        users.add(reviewer.toLowerCase());
    }
  }
  if (!pr.auto_merge)
    await appClient.enablePullRequestAutoMerge(
      event.repo,
      pr.node_id,
      config.merge_method,
    );
  if (users.size || teams.size)
    await appClient.requestReviewers(
      event.repo,
      pr.number,
      [...users],
      [...teams],
    );
  // Write the completion label last. Completed reviews disappear from requested_reviewers,
  // so checking that list alone would request them again on a later webhook/rerun.
  if (!reviewInitialized)
    await appClient.addLabels(event.repo, pr.number, ['ai:awaiting-review']);
  if (pr.labels.includes('ai:stale'))
    await appClient.removeLabel(event.repo, pr.number, 'ai:stale');
  const linked = linkedIssues(pr.body, event.repo);
  if (linked.length)
    log(`Linked issues: ${linked.map((n) => `#${n}`).join(', ')}`);
}
