import { mkdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { assignToCopilot } from '../copilot.js';
import type { Issue } from '../github/client.js';
import { findMarkers, marker } from '../markers.js';
import { capText } from '../text.js';
import {
  decideMode,
  MAX_REVIEW_ROUNDS,
  type RequirementsMode,
} from '../requirements/mode.js';
import { topoSort } from '../requirements/graph.js';
import {
  requirementsPrompt,
  reviewPrompt,
  type ExistingTask,
} from '../requirements/prompts.js';
import { selectReleasable } from '../requirements/release.js';
import {
  hashBody,
  parseState,
  renderState,
  type RequirementsState,
} from '../requirements/state.js';
import { loadTasks, taskId } from '../requirements/tasks.js';
import { validateIssuesJson } from '../requirements/validate.js';
import { factoryComments } from './state.js';
import type { Dependencies } from './types.js';

const snapshotSchema = z.object({
  issue: z.number().int().positive(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(['analyze', 'review', 'release']),
  review_rounds: z.number().int().nonnegative().default(0),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
const recoverySchema = z.object({
  batch: z.string().regex(/^[a-f0-9]{64}$/),
  mode: z.enum(['analyze', 'review']),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  review_rounds: z.number().int().nonnegative().default(0),
  depends_on: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).max(10),
});
function recovery(issue: Issue) {
  const m = findMarkers(issue.body ?? '', 'review').find(
    (m) => m.attrs.kind === 'task',
  );
  const parsed = recoverySchema.safeParse(m?.json);
  return parsed.success ? parsed.data : null;
}
function eligible(issue: Issue) {
  return (
    issue.state === 'open' &&
    !issue.pull_request &&
    issue.labels.includes('requirements')
  );
}
function trustedIssue(issue: Issue, deps: Dependencies) {
  return (
    issue.user?.type === 'Bot' &&
    issue.user.login.toLowerCase() ===
      (deps.event.factoryLogin ?? 'ai-factory[bot]').toLowerCase()
  );
}
export async function inspect(deps: Dependencies, number: number) {
  const { appClient: client, event } = deps;
  const issue = await client.getIssue(event.repo, number);
  const comments = factoryComments(
    await client.listIssueComments(event.repo, number),
    event,
  );
  // Include orphaned creations: an API failure can occur before addSubIssue succeeds.
  const all = await client.listIssues(event.repo, 'all', []);
  const known = all.filter((i) => trustedIssue(i, deps) && taskId(i, number));
  const subIssues = (await client.listSubIssues(event.repo, number)).filter(
    (i) =>
      trustedIssue(i, deps) &&
      taskId(i, number) &&
      known.some((k) => k.id === i.id),
  );
  const blocked = new Map<number, number[]>();
  for (const sub of subIssues)
    blocked.set(
      sub.number,
      (await client.listBlockedBy(event.repo, sub.number)).map((i) => {
        if (!i.id) throw new Error('Dependency is missing its database id');
        return i.id;
      }),
    );
  const tasks = loadTasks(subIssues, blocked, number);
  if (new Set(known.map((i) => taskId(i, number))).size !== known.length)
    throw new Error('Duplicate task markers require human resolution');
  return {
    issue,
    comments,
    known,
    tasks,
    state: parseState(comments),
    hash: hashBody(issue.body),
  };
}
type View = Awaited<ReturnType<typeof inspect>>;
function completed(view: View) {
  return view.comments.some((c) =>
    findMarkers(c.body, 'review').some(
      (m) => m.attrs.kind === 'complete' && m.attrs.hash === view.hash,
    ),
  );
}
function allClosed(view: View) {
  return (
    view.known.every((i) => i.state === 'closed') &&
    view.tasks.every((t) => t.state === 'closed')
  );
}
function atReviewCap(view: View) {
  return (
    view.state?.hash === view.hash &&
    view.state.reviewed_hash !== view.hash &&
    view.state.review_rounds >= MAX_REVIEW_ROUNDS &&
    allClosed(view)
  );
}
function capNotified(view: View) {
  return (
    view.issue.labels.includes('ai:human-needed') &&
    view.comments.some((c) =>
      findMarkers(c.body, 'review').some(
        (m) => m.attrs.kind === 'cap' && m.attrs.hash === view.hash,
      ),
    )
  );
}
function currentMode(view: View, deps: Dependencies): RequirementsMode {
  // Recover a successful review whose final close failed, without another model run.
  if (completed(view) && allClosed(view)) return 'review';
  // Scan stays read-only: the existing apply-only release route posts the cap notice.
  // No fourth think job is scheduled. Once notified, the issue remains idle.
  if (atReviewCap(view)) return capNotified(view) ? 'idle' : 'release';
  if (
    view.state?.hash === view.hash &&
    view.state.reviewed_hash !== view.hash &&
    view.known.some((i) => {
      const r = recovery(i);
      return (
        r?.mode === 'review' &&
        r.hash === view.hash &&
        r.review_rounds === view.state!.review_rounds
      );
    })
  )
    return 'review';
  const mode = decideMode({
    state: view.state,
    bodyHash: view.hash,
    tasks: view.tasks,
    config: deps.config,
  });
  // A previous assignment may have succeeded before its label/table write failed.
  // Refreshing the table is also needed when a task closes while all slots are full.
  if (
    mode === 'idle' &&
    view.state &&
    (!view.comments.some(
      (c) => c.body === renderState(view.state!, view.tasks),
    ) ||
      view.tasks.some(
        (t) =>
          t.state === 'open' &&
          t.assignedToCopilot &&
          !view.known
            .find((i) => i.id === t.issueId)
            ?.labels.includes('ai:in-progress'),
      ))
  )
    return 'release';
  return mode;
}
export function readArtifact(
  directory: string,
  file: string,
  maxBytes = 2000000,
): string {
  if (
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink()
  )
    throw new Error('Artifact directory must be a real directory');
  const path = join(directory, file);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    throw new Error('Invalid or oversized requirements artifact');
  return readFileSync(path, 'utf8');
}
export async function scan(
  deps: Dependencies,
  outputDir?: string,
  requestedIssue?: number,
): Promise<Snapshot[]> {
  const { event, appClient: client, config } = deps;
  if (!config.requirements.enabled) return [];
  let number = requestedIssue;
  if (event.name === 'issues') {
    if (
      !['edited', 'labeled'].includes(event.action) ||
      (event.action === 'labeled' && event.label !== 'requirements')
    )
      return [];
    number = event.issue.number;
  } else if (event.name === 'workflow_dispatch') {
    if (
      !number &&
      event.inputs.issue !== undefined &&
      event.inputs.issue !== ''
    ) {
      number = Number(event.inputs.issue);
      if (!Number.isSafeInteger(number) || number <= 0)
        throw new Error('issue input must be a positive integer');
    }
  } else if (event.name !== 'schedule') return [];
  const issues = number
    ? [await client.getIssue(event.repo, number)]
    : await client.listIssuesByLabel(event.repo, 'requirements');
  const plan: Snapshot[] = [];
  for (const candidate of issues.filter(eligible)) {
    const view = await inspect(deps, candidate.number);
    const issue = view.issue;
    if (!eligible(issue)) continue;
    const mode = currentMode(view, deps);
    if (mode === 'idle') continue;
    const snapshot: Snapshot = {
      issue: issue.number,
      hash: view.hash,
      mode,
      review_rounds:
        view.state?.hash === view.hash ? view.state.review_rounds : 0,
    };
    plan.push(snapshot);
    if (!outputDir) continue;
    const dir = join(outputDir, String(issue.number));
    mkdirSync(dir, { recursive: true });
    if (lstatSync(dir).isSymbolicLink())
      throw new Error('Input directory must not be a symlink');
    const existingTasks: ExistingTask[] = view.known.map((i) => ({
      id: taskId(i, issue.number)!,
      title: i.title ?? '',
      status:
        i.state === 'closed'
          ? 'closed'
          : view.tasks.find((t) => t.issueNumber === i.number)
                ?.assignedToCopilot
            ? 'in-progress'
            : 'open',
    }));
    const prs = [];
    if (mode === 'review')
      for (const task of view.known) {
        for (const ref of await client.listIssueCrossReferences(
          event.repo,
          task.number,
        )) {
          if (ref.repo.toLowerCase() !== event.repo.toLowerCase()) continue;
          const pr = await client.getPullRequest(event.repo, ref.number);
          prs.push({
            task: taskId(task, issue.number),
            number: pr.number,
            state: pr.state,
            merged_at: pr.merged_at,
            body: pr.body,
          });
        }
      }
    const files = {
      'snapshot.json': JSON.stringify(snapshot),
      'requirements.md': issue.body ?? '',
      'existing-tasks.json': JSON.stringify(existingTasks),
      'mode.txt': mode,
      'prompt.md':
        mode === 'review'
          ? reviewPrompt(issue, existingTasks, prs)
          : requirementsPrompt(issue, existingTasks),
    };
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(dir, name), content, { flag: 'wx' });
  }
  return plan;
}
async function writeState(
  deps: Dependencies,
  view: View,
  state: RequirementsState,
) {
  const body = renderState(state, view.tasks);
  const comment = view.comments.find(
    (c) => findMarkers(c.body, 'req-state').length,
  );
  if (comment) {
    if (comment.body !== body)
      await deps.appClient.updateComment(deps.event.repo, comment.id, body);
  } else
    await deps.appClient.createComment(
      deps.event.repo,
      view.issue.number,
      body,
    );
}
async function release(deps: Dependencies, number: number) {
  const { appClient: client, userClient, event, config } = deps;
  let view = await inspect(deps, number);
  if (!eligible(view.issue) || view.state?.hash !== view.hash) return;
  // Repair label writes interrupted after assignment, without assigning twice.
  for (const t of view.tasks.filter(
    (t) => t.state === 'open' && t.assignedToCopilot,
  ))
    await client.addLabels(event.repo, t.issueNumber, ['ai:in-progress']);
  for (const t of selectReleasable(view.tasks, config.requirements.max_open)) {
    await assignToCopilot(userClient, {
      repo: event.repo,
      issue: t.issueNumber,
      baseBranch: config.base_branch,
      customAgent: config.agents.implementer,
      model: config.model,
      instructions: `This task is part of requirements #${number}. Only do this task.`,
    });
    await client.addLabels(event.repo, t.issueNumber, ['ai:in-progress']);
  }
  view = await inspect(deps, number);
  if (view.state) {
    const changed = !view.comments.some(
      (c) => c.body === renderState(view.state!, view.tasks),
    );
    await writeState(
      deps,
      view,
      changed
        ? { ...view.state, last_run: event.runUrl ?? view.state.last_run }
        : view.state,
    );
  }
}
async function repairLinks(deps: Dependencies, number: number, known: Issue[]) {
  for (const issue of known) {
    if (!issue.id) throw new Error('Task is missing its database id');
    await deps.appClient.addSubIssue(deps.event.repo, number, issue.id);
    for (const id of recovery(issue)?.depends_on ?? []) {
      const blocker = known.find((i) => taskId(i, number) === id);
      if (!blocker?.id)
        throw new Error('Missing task dependency; refusing release');
      await deps.appClient.addBlockedBy(
        deps.event.repo,
        issue.number,
        blocker.id,
      );
    }
  }
}
export async function apply(
  deps: Dependencies,
  snapshot: Snapshot,
  raw?: string,
): Promise<number> {
  snapshot = snapshotSchema.parse(snapshot);
  const { appClient: client, event, config } = deps;
  if (!config.requirements.enabled) return 0;
  const number = snapshot.issue;
  let view = await inspect(deps, number);
  if (!eligible(view.issue) || view.hash !== snapshot.hash) {
    deps.log('Skipped changed or closed requirements');
    return 0;
  }
  if (completed(view) && allClosed(view)) {
    await writeState(deps, view, {
      version: 1,
      hash: view.hash,
      reviewed_hash: view.hash,
      review_rounds:
        view.state?.hash === view.hash ? view.state.review_rounds : 0,
      last_run:
        (view.state?.hash === view.hash ? view.state.last_run : event.runUrl) ??
        '',
    });
    await client.closeIssue(event.repo, number);
    return 0;
  }
  if (atReviewCap(view)) {
    await writeState(deps, view, view.state!);
    await client.addLabels(event.repo, number, ['ai:human-needed']);
    if (
      !view.comments.some((c) =>
        findMarkers(c.body, 'review').some(
          (m) => m.attrs.kind === 'cap' && m.attrs.hash === view.hash,
        ),
      )
    )
      await client.createComment(
        event.repo,
        number,
        `**Requirements review needs human help.**\n\nThe ${MAX_REVIEW_ROUNDS} gap-review rounds are exhausted. Review the remaining requirements before continuing. Editing the requirements body starts a new analysis and resets the round count.\n\n${marker('review', { kind: 'cap', hash: view.hash })}`,
      );
    return 0;
  }
  if (snapshot.mode === 'release') {
    if (
      currentMode(view, deps) !== 'analyze' &&
      currentMode(view, deps) !== 'review'
    )
      await release(deps, number);
    return 0;
  }
  if (snapshot.mode === 'analyze' && view.state?.hash === view.hash) {
    if (currentMode(view, deps) !== 'review') await release(deps, number);
    return 0;
  }
  if (
    snapshot.mode === 'review' &&
    view.state?.hash === view.hash &&
    (view.state.reviewed_hash === view.hash ||
      view.state.review_rounds > snapshot.review_rounds)
  ) {
    if (currentMode(view, deps) !== 'review') await release(deps, number);
    return 0;
  }
  if (
    snapshot.mode === 'review' &&
    view.state?.review_rounds !== snapshot.review_rounds
  )
    return 0;
  if (snapshot.mode === 'review' && currentMode(view, deps) !== 'review')
    return 0;
  const batch = hashBody(raw ?? '');
  const existingIds = new Set(
    view.known
      .filter((i) => {
        const r = recovery(i);
        return (
          r?.batch !== batch ||
          r.hash !== view.hash ||
          r.mode !== snapshot.mode ||
          (snapshot.mode === 'review' &&
            r.review_rounds !== snapshot.review_rounds)
        );
      })
      .map((i) => taskId(i, number)!),
  );
  const validated = validateIssuesJson(
    raw ?? '',
    existingIds,
    config.requirements.max_tasks_per_run,
  );
  if (!validated.ok) {
    if (
      !view.comments.some((c) =>
        findMarkers(c.body, 'review').some(
          (m) => m.attrs.kind === 'invalid' && m.attrs.hash === view.hash,
        ),
      )
    )
      await client.createComment(
        event.repo,
        number,
        `**Requirements output is invalid.**\n\n${capText(validated.errors.map((e) => `- ${e.replace(/</g, '&lt;').replace(/>/g, '&gt;')}`).join('\n'), 45000, 45000)}\n\n${marker('review', { kind: 'invalid', hash: view.hash })}`,
      );
    return 1;
  }
  await repairLinks(deps, number, view.known);
  for (const task of topoSort(validated.tasks)) {
    const exists = view.known.find((i) => taskId(i, number) === task.id);
    if (exists) continue; // Only an exact batch replay can pass the existing-id check.
    const body = `${task.body}\n\n${marker('review', { kind: 'task' }, { batch, mode: snapshot.mode, hash: view.hash, review_rounds: snapshot.mode === 'review' ? snapshot.review_rounds : 0, depends_on: task.depends_on })}\n${marker('task', { req: String(number), id: task.id })}`;
    const created = await client.createIssue(event.repo, task.title, body);
    view.known.push(created);
    await repairLinks(deps, number, view.known);
  }
  view = await inspect(deps, number);
  if (!eligible(view.issue) || view.hash !== snapshot.hash) {
    deps.log(
      'Requirements changed during creation; leaving state unchanged for the next analysis',
    );
    return 0;
  }
  const reviewHasGaps =
    snapshot.mode === 'review' &&
    (validated.tasks.length > 0 ||
      view.known.some((i) => {
        const r = recovery(i);
        return (
          r?.mode === 'review' &&
          r.hash === view.hash &&
          r.review_rounds === snapshot.review_rounds
        );
      }));
  const finishes = !validated.tasks.length && !reviewHasGaps && allClosed(view);
  const state: RequirementsState = {
    version: 1,
    hash: view.hash,
    reviewed_hash: finishes
      ? view.hash
      : snapshot.mode === 'review'
        ? (view.state?.reviewed_hash ?? '')
        : '',
    review_rounds:
      snapshot.mode === 'analyze'
        ? 0
        : snapshot.review_rounds + (reviewHasGaps ? 1 : 0),
    last_run: event.runUrl ?? '',
  };
  if (finishes) {
    if (!completed(view))
      await client.createComment(
        event.repo,
        number,
        `${snapshot.mode === 'analyze' ? '**Nothing to implement: the repository already covers these requirements.**' : '**All requirements implemented.**'}\n\n${marker('review', { kind: 'complete', hash: view.hash })}`,
      );
    await writeState(deps, view, state);
    await client.closeIssue(event.repo, number);
  } else {
    await writeState(deps, view, state);
    await release(deps, number);
  }
  return 0;
}
export function readSnapshot(directory: string): Snapshot {
  return snapshotSchema.parse(
    JSON.parse(readArtifact(directory, 'snapshot.json', 4096)),
  );
}
