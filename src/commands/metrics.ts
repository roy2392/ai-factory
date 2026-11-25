import {
  appendFileSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Comment } from '../github/client.js';
import { isCopilot } from '../copilot.js';
import {
  computeMetrics,
  metricsWindow,
  renderMetrics,
  withinWindow,
} from '../metrics.js';
import type { Dependencies } from './types.js';

export async function run(
  { appClient: client, event, log }: Dependencies,
  {
    since = '30d',
    outputDir = '.',
    summaryPath,
    dryRun = false,
    now = new Date(),
  }: {
    since?: string;
    outputDir?: string;
    summaryPath?: string;
    dryRun?: boolean;
    now?: Date;
  } = {},
) {
  const window = metricsWindow(since, now);
  const [prs, issues] = await Promise.all([
    client.listPullRequests(event.repo, 'all'),
    client.listIssues(event.repo, 'all', []),
  ]);
  const comments = new Map<number, Comment[]>(),
    reviewFeedback = new Map<number, Comment[]>();
  for (const pr of prs.filter((pr) => pr.user && isCopilot(pr.user.login))) {
    comments.set(
      pr.number,
      await client.listIssueComments(event.repo, pr.number),
    );
    if (withinWindow(pr.merged_at, window)) {
      const [reviews, inline] = await Promise.all([
        client.listPullRequestReviews(event.repo, pr.number),
        client.listPullRequestReviewComments(event.repo, pr.number),
      ]);
      reviewFeedback.set(pr.number, [...reviews, ...inline]);
    }
  }
  for (const issue of issues.filter(
    (i) =>
      i.labels.includes('requirements') &&
      i.state === 'closed' &&
      withinWindow(i.closed_at, window),
  ))
    comments.set(
      issue.number,
      await client.listIssueComments(event.repo, issue.number),
    );
  const metrics = computeMetrics({
    repo: event.repo,
    window,
    prs,
    issues,
    comments,
    reviewFeedback,
    factoryLogin: event.factoryLogin ?? 'ai-factory[bot]',
    botLogin: event.botLogin,
  });
  const markdown = renderMetrics(metrics);
  if (!dryRun) {
    mkdirSync(outputDir, { recursive: true });
    if (
      !lstatSync(outputDir).isDirectory() ||
      lstatSync(outputDir).isSymbolicLink()
    )
      throw new Error('Metrics output directory must be a real directory');
    // Refuse to follow a pre-existing symlink at the output destination.
    const fd = openSync(
      join(outputDir, 'metrics.json'),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_TRUNC |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, `${JSON.stringify(metrics, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    if (summaryPath) appendFileSync(summaryPath, `${markdown}\n`);
  }
  log(markdown);
  return metrics;
}
