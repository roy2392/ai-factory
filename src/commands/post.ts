import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThinkMode } from '../copilot-cli.js';
import { findMarkers, marker } from '../markers.js';
import { capText } from '../text.js';
import { factoryComments, hasSource, sourceOf } from './state.js';
import type { Dependencies } from './types.js';

export function stripFactoryMarkers(text: string): string {
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<!--\s*ai-factory:[\s\S]*?(?:-->|$)/gi, '');
  } while (text !== previous);
  return text;
}
export function hasOpenQuestions(text: string): boolean {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) =>
    /^##[ \t]+Open questions[ \t]*#*[ \t]*$/i.test(line),
  );
  if (start < 0) return true;
  const remaining = lines.slice(start + 1);
  const next = remaining.findIndex((line) => /^##[ \t]/.test(line));
  const section = remaining
    .slice(0, next < 0 ? undefined : next)
    .join('\n')
    .trim();
  return !section || !/^None\.?$/i.test(section);
}

export async function run(
  deps: Dependencies,
  { mode, outputDir = 'out' }: { mode: ThinkMode; outputDir?: string },
): Promise<number> {
  const { event, appClient } = deps;
  if (event.name !== 'issues' && event.name !== 'issue_comment')
    throw new Error('post requires an issue event');
  const source = sourceOf(event);
  const issue = await appClient.getIssue(event.repo, event.issue.number);
  if (issue.pull_request) throw new Error('Cannot publish to a pull request');
  const comments = factoryComments(
    await appClient.listIssueComments(event.repo, issue.number),
    event,
  );
  const kind = mode === 'plan' ? 'plan' : 'answer';
  const existing = comments.find(
    (c) =>
      hasSource(c, kind, source) &&
      findMarkers(c.body, kind).some(
        (m) => m.attrs.source === source && m.attrs.state !== 'failed',
      ),
  );
  let content = existing?.body;
  let publishedId = existing?.id;
  if (!existing) {
    let raw = '';
    try {
      const path = join(outputDir, mode === 'plan' ? 'plan.md' : 'answer.md');
      const stat = lstatSync(path);
      if (stat.isFile() && stat.size <= 5_000_000)
        raw = readFileSync(path, 'utf8');
    } catch {
      /* Missing artifacts follow the same failure-comment path. */
    }
    const sanitized = stripFactoryMarkers(raw).trim();
    const failure = comments.find((c) =>
      findMarkers(c.body, 'answer').some(
        (m) =>
          m.attrs.source === source &&
          m.attrs.cmd === mode &&
          m.attrs.state === 'failed',
      ),
    );
    if (!sanitized) {
      const runUrl =
        event.runUrl ?? `${issue.html_url.split('/issues/')[0]}/actions`;
      const body = `**Planning failed.** See run ${runUrl}.\n\n${marker('answer', { cmd: mode, source, state: 'failed' })}`;
      if (failure) await appClient.updateComment(event.repo, failure.id, body);
      else await appClient.createComment(event.repo, issue.number, body);
      return 1;
    }
    const limited = capText(sanitized, 49750, 57000);
    content = `${mode === 'plan' ? '**Plan ready for review.**' : '**Answer.**'}\n\n${limited}${limited !== sanitized ? '\n\n[Output truncated.]' : ''}${mode === 'plan' ? '\n\nReply `/ai go` to start implementation.' : ''}\n\n${marker(kind, { ...(mode === 'ask' ? { cmd: 'ask' } : {}), source })}`;
    if (failure) {
      publishedId = failure.id;
      await appClient.updateComment(event.repo, failure.id, content);
    } else await appClient.createComment(event.repo, issue.number, content);
  }
  if (mode === 'plan') {
    const latest = [...comments]
      .sort((a, b) => b.id - a.id)
      .find((c) => findMarkers(c.body, 'plan').length);
    if (publishedId !== undefined && latest && latest.id > publishedId)
      return 0;
    // Remove our footer before interpreting the questions section on a retry.
    const plan = content!.split('\n\nReply `/ai go`')[0]!;
    const needsInfo = hasOpenQuestions(plan);
    const opposite = needsInfo ? 'ai:plan-ready' : 'ai:needs-info';
    const label = needsInfo ? 'ai:needs-info' : 'ai:plan-ready';
    if (issue.labels.includes(opposite))
      await appClient.removeLabel(event.repo, issue.number, opposite);
    if (!issue.labels.includes(label))
      await appClient.addLabels(event.repo, issue.number, [label]);
  }
  return 0;
}
