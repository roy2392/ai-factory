import { readFileSync } from 'node:fs';
import { z } from 'zod';
import {
  repoParts,
  type Issue,
  type PullRequest,
  type WorkflowRun,
} from './github/client.js';

const actor = z.object({ login: z.string().min(1), type: z.string() });
const label = z.union([z.string(), z.object({ name: z.string() })]);
const issueSchema = z.object({
  updated_at: z.string().optional(),
  title: z.string().optional(),
  number: z.number().int().positive(),
  html_url: z.string(),
  state: z.enum(['open', 'closed']),
  user: actor.nullable(),
  author_association: z.string(),
  body: z.string().nullable(),
  labels: z
    .array(label)
    .transform((labels) =>
      labels.map((v) => (typeof v === 'string' ? v : v.name)),
    ),
  assignees: z.array(z.object({ login: z.string() })),
  pull_request: z.unknown().optional(),
});
const prSchema = z.object({
  updated_at: z.string().optional(),
  merged_at: z.string().nullable().optional(),
  number: z.number().int().positive(),
  node_id: z.string().min(1),
  state: z.enum(['open', 'closed']),
  user: actor.nullable(),
  body: z.string().nullable(),
  draft: z.boolean(),
  head: z.object({
    ref: z.string(),
    sha: z.string().optional(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string() }),
  }),
  auto_merge: z.object({ merge_method: z.string() }).nullable(),
  labels: z
    .array(label)
    .transform((labels) =>
      labels.map((v) => (typeof v === 'string' ? v : v.name)),
    ),
  requested_reviewers: z.array(z.object({ login: z.string() })),
  requested_teams: z.array(z.object({ slug: z.string() })),
});

export function parseIssue(value: unknown): Issue {
  return issueSchema.parse(value);
}
export function parsePullRequest(value: unknown): PullRequest {
  return prSchema.parse(value);
}

interface BaseEvent {
  repo: string;
  botLogin?: string;
  factoryLogin?: string;
  runId?: string;
  runUrl?: string;
}
export type FactoryEvent = BaseEvent &
  (
    | { name: 'issues'; action: string; issue: Issue; label?: string }
    | {
        name: 'issue_comment';
        action: string;
        issue: Issue;
        comment: {
          id: number;
          body: string;
          html_url?: string;
          user: z.infer<typeof actor>;
          author_association: string;
        };
      }
    | { name: 'pull_request_target'; action: string; pullRequest: PullRequest }
    | {
        name: 'workflow_run';
        action: string;
        workflowRun: WorkflowRun;
      }
    | { name: 'schedule'; schedule: string }
    | { name: 'workflow_dispatch'; inputs: Record<string, unknown> }
  );

export function readEvent(env: NodeJS.ProcessEnv = process.env): FactoryEvent {
  const name = env.GITHUB_EVENT_NAME;
  if (
    ![
      'issues',
      'issue_comment',
      'pull_request_target',
      'workflow_run',
      'schedule',
      'workflow_dispatch',
    ].includes(name ?? '')
  ) {
    throw new Error(`Unsupported GitHub event: ${name ?? '(missing)'}`);
  }
  if (!env.GITHUB_EVENT_PATH) throw new Error('GITHUB_EVENT_PATH is required');
  const repo = env.GITHUB_REPOSITORY ?? '';
  repoParts(repo);
  const payload = z
    .record(z.string(), z.unknown())
    .parse(JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) as unknown);
  const base = {
    repo,
    ...(env.COPILOT_BOT_LOGIN ? { botLogin: env.COPILOT_BOT_LOGIN } : {}),
    factoryLogin: env.FACTORY_APP_LOGIN ?? 'ai-factory[bot]',
    runId: env.GITHUB_RUN_ID,
    runUrl: env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined,
  };
  switch (name) {
    case 'issues':
      return {
        ...base,
        name,
        action: z.string().parse(payload.action),
        issue: parseIssue(payload.issue),
        label:
          payload.label === undefined
            ? undefined
            : z.object({ name: z.string() }).parse(payload.label).name,
      };
    case 'issue_comment':
      return {
        ...base,
        name,
        action: z.string().parse(payload.action),
        issue: parseIssue(payload.issue),
        comment: z
          .object({
            id: z.number().int().positive(),
            body: z.string(),
            html_url: z.string().optional(),
            user: actor,
            author_association: z.string(),
          })
          .parse(payload.comment),
      };
    case 'pull_request_target':
      return {
        ...base,
        name,
        action: z.string().parse(payload.action),
        pullRequest: parsePullRequest(payload.pull_request),
      };
    case 'workflow_run':
      return {
        ...base,
        name,
        action: z.string().parse(payload.action),
        workflowRun: z
          .object({
            id: z.number().int().positive(),
            name: z.string(),
            event: z.string(),
            head_branch: z.string().nullable(),
            head_sha: z.string().min(1),
            head_repository: z.object({ full_name: z.string() }).nullable(),
            repository: z.object({ full_name: z.string() }),
            conclusion: z.string().nullable(),
            html_url: z.url(),
          })
          .parse(payload.workflow_run),
      };
    case 'schedule':
      return { ...base, name, schedule: z.string().parse(payload.schedule) };
    default:
      return {
        ...base,
        name: 'workflow_dispatch',
        inputs: z.record(z.string(), z.unknown()).parse(payload.inputs ?? {}),
      };
  }
}
