import type { Comment, Issue, PullRequest } from './github/client.js';
import { isCopilot } from './copilot.js';
import { linkedIssues } from './links.js';
import { findMarkers } from './markers.js';
import { hashBody } from './requirements/state.js';

export interface MetricsWindow {
  since: string;
  until: string;
}
export function metricsWindow(since = '30d', now = new Date()): MetricsWindow {
  const match = /^([1-9]\d*)([dhw])$/.exec(since);
  if (!match)
    throw new Error(
      '--since must be a positive duration such as 30d, 24h or 4w',
    );
  const units: Record<string, number> = {
    h: 3600000,
    d: 86400000,
    w: 604800000,
  };
  const duration = Number(match[1]) * units[match[2]!]!;
  const start = new Date(now.getTime() - duration);
  if (
    !Number.isSafeInteger(duration) ||
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(now.getTime())
  )
    throw new Error('Invalid metrics time window');
  return { since: start.toISOString(), until: now.toISOString() };
}
export function withinWindow(
  value: string | null | undefined,
  window: MetricsWindow,
): boolean {
  const time = Date.parse(value ?? '');
  return (
    Number.isFinite(time) &&
    time >= Date.parse(window.since) &&
    time <= Date.parse(window.until)
  );
}
export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

// Human-requested changes is a mention-based signal: a case-insensitive standalone
// @copilot in a PR conversation comment, inline review comment, or submitted review
// body, authored by a GitHub User (not a Bot, [bot] login, Copilot, or the configured
// automation bot user). Count only feedback created by the merge time, including
// feedback before --since. An approval/CHANGES_REQUESTED review without @copilot
// does not satisfy this signal; neither do post-merge comments or @copilot-other.
export function humanRequestedChanges(
  feedback: readonly Comment[],
  mergedAt: string,
  botLogin?: string,
): boolean {
  const merged = Date.parse(mergedAt);
  return feedback.some(
    (c) =>
      c.user?.type === 'User' &&
      !/\[bot\]$/i.test(c.user.login) &&
      !isCopilot(c.user.login) &&
      c.user.login.toLowerCase() !== botLogin?.toLowerCase() &&
      /(?<![\w@])@copilot(?![\w-])/i.test(c.body) &&
      Number.isFinite(Date.parse(c.created_at ?? '')) &&
      Date.parse(c.created_at!) <= merged,
  );
}
export interface MetricsInput {
  repo: string;
  window: MetricsWindow;
  prs: PullRequest[];
  issues: Issue[];
  comments: Map<number, Comment[]>;
  reviewFeedback: Map<number, Comment[]>;
  factoryLogin: string;
  botLogin?: string;
}
export function computeMetrics(input: MetricsInput) {
  const {
    repo,
    window,
    issues,
    comments,
    reviewFeedback,
    factoryLogin,
    botLogin,
  } = input;
  const inWindow = (date: string | null | undefined) =>
    withinWindow(date, window);
  const appActor = (user: Issue['user'] | undefined) =>
    user?.type === 'Bot' &&
    user.login.toLowerCase() === factoryLogin.toLowerCase();
  const receiptActor = (c: Comment) =>
    appActor(c.user) ||
    (c.user?.type === 'User' &&
      !!botLogin &&
      c.user.login.toLowerCase() === botLogin.toLowerCase());
  const prs = input.prs.filter((pr) => pr.user && isCopilot(pr.user.login));
  const merged = prs.filter((pr) => inWindow(pr.merged_at));
  // One sample per merged PR: use its earliest valid linked local issue creation.
  // Links reuse the factory's Fixes/Closes/Resolves parser. Unlinked/invalid dates
  // are excluded, not treated as zero; issue creation can precede the window.
  const hours: number[] = [];
  for (const pr of merged) {
    const end = Date.parse(pr.merged_at!);
    const starts = linkedIssues(pr.body, repo).flatMap((number) => {
      const issue = issues.find((i) => i.number === number && !i.pull_request);
      const start = Date.parse(issue?.created_at ?? '');
      return Number.isFinite(start) && start <= end ? [start] : [];
    });
    if (starts.length) hours.push((end - Math.min(...starts)) / 3600000);
  }
  const noChanges = merged.filter(
    (pr) =>
      !humanRequestedChanges(
        [
          ...(comments.get(pr.number) ?? []),
          ...(reviewFeedback.get(pr.number) ?? []),
        ],
        pr.merged_at!,
        botLogin,
      ),
  ).length;
  const perPr = prs
    .flatMap((pr) => {
      const runs = new Set<string>();
      let gaveUp = false;
      for (const comment of comments.get(pr.number) ?? []) {
        if (!receiptActor(comment) || !inWindow(comment.created_at)) continue;
        for (const m of findMarkers(comment.body, 'self-heal')) {
          if (m.attrs.state === 'gave-up') gaveUp = true;
          if (
            /^[1-9]\d*$/.test(m.attrs.run ?? '') &&
            /^(?:[1-9]|10)$/.test(m.attrs.attempt ?? '')
          )
            runs.add(m.attrs.run!);
        }
      }
      return runs.size || gaveUp
        ? [{ pr: pr.number, attempts: runs.size, gave_up: gaveUp }]
        : [];
    })
    .sort((a, b) => a.pr - b.pr);
  const gaveUpCount = perPr.filter((p) => p.gave_up).length;
  const tasks = issues.filter(
    (i) =>
      !i.pull_request &&
      appActor(i.user) &&
      findMarkers(i.body ?? '', 'task').some(
        (m) =>
          /^[1-9]\d*$/.test(m.attrs.req ?? '') &&
          /^[a-z0-9-]{1,40}$/.test(m.attrs.id ?? ''),
      ),
  );
  const fullyClosed = issues.filter(
    (i) =>
      !i.pull_request &&
      i.labels.includes('requirements') &&
      i.state === 'closed' &&
      inWindow(i.closed_at) &&
      (comments.get(i.number) ?? []).some(
        (c) =>
          appActor(c.user) &&
          Number.isFinite(Date.parse(c.created_at ?? '')) &&
          Date.parse(c.created_at!) <= Date.parse(i.closed_at!) &&
          findMarkers(c.body, 'review').some(
            (m) =>
              m.attrs.kind === 'complete' && m.attrs.hash === hashBody(i.body),
          ),
      ),
  );
  return {
    version: 1,
    repo,
    window,
    identities: { factory_login: factoryLogin, bot_login: botLogin ?? null },
    pull_requests: {
      opened: prs.filter((pr) => inWindow(pr.created_at)).length,
      merged: merged.length,
      closed_unmerged: prs.filter(
        (pr) =>
          pr.state === 'closed' && !pr.merged_at && inWindow(pr.closed_at),
      ).length,
      median_issue_to_merge_hours: median(hours),
      issue_to_merge_samples: hours.length,
      merged_without_human_changes: noChanges,
      merged_without_human_changes_share: merged.length
        ? noChanges / merged.length
        : null,
    },
    self_heal: {
      per_pr: perPr,
      observed_prs: perPr.length,
      mean_attempts_per_pr: perPr.length
        ? perPr.reduce((sum, p) => sum + p.attempts, 0) / perPr.length
        : null,
      gave_up: gaveUpCount,
      gave_up_share: perPr.length ? gaveUpCount / perPr.length : null,
      user_receipts_included: !!botLogin,
    },
    requirements: {
      tasks_created: tasks.filter((t) => inWindow(t.created_at)).length,
      tasks_closed: tasks.filter(
        (t) => t.state === 'closed' && inWindow(t.closed_at),
      ).length,
      issues_fully_closed: fullyClosed.length,
    },
  };
}
export type Metrics = ReturnType<typeof computeMetrics>;
export function renderMetrics(metrics: Metrics): string {
  const p = metrics.pull_requests,
    s = metrics.self_heal,
    r = metrics.requirements;
  const decimal = (n: number | null) => (n === null ? 'N/A' : n.toFixed(2));
  const percent = (n: number | null) =>
    n === null ? 'N/A' : `${(n * 100).toFixed(1)}%`;
  const rows = [
    ['Copilot PRs opened', p.opened],
    ['Copilot PRs merged', p.merged],
    ['Copilot PRs closed unmerged', p.closed_unmerged],
    [
      'Median issue-to-merge hours',
      `${decimal(p.median_issue_to_merge_hours)} (${p.issue_to_merge_samples} samples)`,
    ],
    [
      'Merged without human-requested changes',
      `${percent(p.merged_without_human_changes_share)} (${p.merged_without_human_changes}/${p.merged})`,
    ],
    [
      'Self-heal attempts per observed PR (mean)',
      decimal(s.mean_attempts_per_pr),
    ],
    [
      'Self-heal PRs that gave up',
      `${percent(s.gave_up_share)} (${s.gave_up}/${s.observed_prs})`,
    ],
    ['Requirements tasks created', r.tasks_created],
    ['Requirements tasks closed', r.tasks_closed],
    ['Requirements issues fully closed', r.issues_fully_closed],
  ];
  let text = `## Factory metrics: ${metrics.repo}\n\nUTC window: ${metrics.window.since} through ${metrics.window.until} (inclusive).\n\n| Metric | Value |\n| --- | --- |\n${rows.map(([label, value]) => `| ${label} | ${value} |`).join('\n')}\n`;
  if (s.per_pr.length)
    text += `\n| PR | Self-heal attempts in window | Gave up in window |\n| --- | --- | --- |\n${s.per_pr.map((pr) => `| #${pr.pr} | ${pr.attempts} | ${pr.gave_up ? 'yes' : 'no'} |`).join('\n')}\n`;
  if (!s.user_receipts_included)
    text +=
      '\nCOPILOT_BOT_LOGIN is unset: licensed-user repair receipts are excluded and that account cannot be excluded from the human-change signal.\n';
  return text;
}
