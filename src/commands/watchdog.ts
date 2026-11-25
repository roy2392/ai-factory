import { isCopilot } from '../copilot.js';
import type { Issue, PullRequest } from '../github/client.js';
import { findMarkers, marker } from '../markers.js';
import { isStale, linkedIssues, needsStaleComment } from '../watchdog.js';
import { factoryComments } from './state.js';
import { notice, type Dependencies } from './types.js';

export async function run(
  { event, appClient, config, log }: Dependencies,
  now = new Date(),
): Promise<void> {
  if (!['schedule', 'workflow_dispatch'].includes(event.name)) {
    notice(log, 'unsupported watchdog trigger');
    return;
  }
  const repo = event.repo;
  const allPrs = await appClient.listPullRequests(repo, 'all');
  const local = (pr: PullRequest) =>
    pr.base.repo.full_name.toLowerCase() === repo.toLowerCase() &&
    (!pr.head.repo ||
      pr.head.repo.full_name.toLowerCase() === repo.toLowerCase());
  const copilotPrs = allPrs.filter(
    (pr) => pr.user && isCopilot(pr.user.login) && local(pr),
  );
  const issues = await appClient.listIssues(repo, 'all', ['ai:in-progress']);
  const byNumber = new Map(allPrs.map((pr) => [pr.number, pr]));
  const candidates: (
    { kind: 'pr'; item: PullRequest } | { kind: 'issue'; item: Issue }
  )[] = [
    ...copilotPrs
      .filter(
        (pr) =>
          pr.state === 'open' &&
          pr.draft &&
          isStale(pr.updated_at, now, config.stale_hours),
      )
      .map((item) => ({ kind: 'pr' as const, item })),
    ...issues.map((item) => ({ kind: 'issue' as const, item })),
  ];
  candidates.sort(
    (a, b) =>
      (Date.parse(a.item.updated_at ?? '') || 0) -
        (Date.parse(b.item.updated_at ?? '') || 0) ||
      a.item.number - b.item.number,
  );
  const rows: string[] = [];
  const stale = async (
    number: number,
    kind: 'pr' | 'issue',
    updatedAt: string | undefined,
    mentions = '',
  ) => {
    const comments = factoryComments(
      await appClient.listIssueComments(repo, number),
      event,
    ).filter((c) =>
      findMarkers(c.body, 'stale').some((m) => m.attrs.kind === kind),
    );
    if (!needsStaleComment(comments, updatedAt)) return 'already-notified';
    // The notification is the final write so its timestamp covers our label update.
    await appClient.addLabels(repo, number, ['ai:stale']);
    await appClient.createComment(
      repo,
      number,
      `**Copilot work appears stale.** ${mentions}\n\n${kind === 'pr' ? 'This draft PR has had no recent activity.' : 'This issue has no linked open PR.'} Please check progress; the inactivity threshold is ${config.stale_hours} hours.\n\n${marker('stale', { kind })}`,
    );
    return 'notified';
  };
  for (const candidate of candidates.slice(0, 50)) {
    const { item } = candidate;
    let status = 'unchanged';
    if (candidate.kind === 'pr') {
      const issueNumber = linkedIssues(item.body, repo)[0];
      let mentions = '';
      if (issueNumber) {
        try {
          const linked = await appClient.getIssue(repo, issueNumber);
          if (linked.user && /^[A-Za-z0-9-]+$/.test(linked.user.login))
            mentions = `@${linked.user.login}`;
        } catch (error) {
          if (!(
            typeof error === 'object' &&
            error !== null &&
            'status' in error &&
            error.status === 404
          ))
            throw error;
        }
      }
      status = await stale(item.number, 'pr', item.updated_at, mentions);
    } else {
      const connected = new Map(
        copilotPrs
          .filter((pr) => linkedIssues(pr.body, repo).includes(item.number))
          .map((pr) => [pr.number, pr]),
      );
      for (const reference of await appClient.listIssueCrossReferences(
        repo,
        item.number,
      )) {
        if (reference.repo.toLowerCase() !== repo.toLowerCase()) continue;
        let pr = byNumber.get(reference.number);
        if (!pr) {
          pr = await appClient.getPullRequest(repo, reference.number);
          byNumber.set(pr.number, pr);
        }
        if (local(pr)) connected.set(pr.number, pr);
      }
      const linked = [...connected.values()];
      if (linked.some((pr) => pr.state === 'open')) status = 'linked-open-pr';
      else if (
        linked.some(
          (pr) => pr.state === 'closed' && pr.user && isCopilot(pr.user.login),
        )
      ) {
        await appClient.removeLabel(repo, item.number, 'ai:in-progress');
        await appClient.removeLabel(repo, item.number, 'ai:awaiting-review');
        status = 'cleaned';
      } else if (
        candidate.item.state === 'open' &&
        candidate.item.assignees.some(({ login }) => isCopilot(login)) &&
        isStale(item.updated_at, now, config.stale_hours)
      ) {
        status = await stale(item.number, 'issue', item.updated_at);
      }
    }
    rows.push(`${candidate.kind}\t#${item.number}\t${status}`);
  }
  log('Kind\tItem\tResult');
  for (const row of rows) log(row);
  log(
    `Processed ${rows.length} of ${candidates.length} candidates (limit 50).`,
  );
}
