import { parse } from 'yaml';
import { z } from 'zod';
import type { GitHubClient, Repository } from './github/client.js';

export const configSchema = z
  .object({
    version: z.literal(1).default(1),
    base_branch: z.string().min(1).default('main'),
    model: z.string().default(''),
    allowed_associations: z
      .array(z.enum(['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR']))
      .default(['OWNER', 'MEMBER', 'COLLABORATOR']),
    labels: z
      .object({
        skip: z.array(z.string().min(1)).default(['ai:manual', 'requirements']),
        needs_plan: z.string().min(1).default('ai:needs-plan'),
      })
      .strict()
      .prefault({}),
    plan_gate: z.enum(['label', 'always', 'never']).default('label'),
    agents: z
      .object({
        implementer: z.string().default('implementer'),
        review_triage: z.string().default('review-triage'),
      })
      .strict()
      .prefault({}),
    merge_method: z.enum(['merge', 'squash', 'rebase']).default('squash'),
    reviewers: z.array(z.string().min(1)).default([]),
    max_fix_attempts: z.number().int().min(0).max(10).default(3),
    escalate_to: z.array(z.string().min(1)).default([]),
    stale_hours: z.number().int().min(1).max(168).default(6),
    requirements: z
      .object({
        enabled: z.boolean().default(true),
        max_open: z.number().int().min(1).max(20).default(3),
        max_tasks_per_run: z.number().int().min(1).max(30).default(15),
      })
      .strict()
      .prefault({}),
  })
  .strict();

export type FactoryConfig = z.infer<typeof configSchema>;
export const DEFAULT_CONFIG: FactoryConfig = configSchema.parse({});

export async function loadConfig(
  client: GitHubClient,
  repo: Repository,
  ref: string,
): Promise<FactoryConfig> {
  const content = await client.getFile(
    repo.full_name,
    '.github/ai-factory.yml',
    ref,
  );
  let value: unknown;
  try {
    value = content === null ? {} : ((parse(content) as unknown) ?? {});
  } catch {
    throw new Error('Invalid YAML in .github/ai-factory.yml');
  }
  const result = configSchema.safeParse(value);
  if (!result.success) {
    const paths = result.error.issues.flatMap((issue) =>
      issue.code === 'unrecognized_keys'
        ? issue.keys.map((key) => [...issue.path, key].join('.'))
        : [issue.path.join('.') || '(root)'],
    );
    throw new Error(`Invalid .github/ai-factory.yml keys: ${paths.join(', ')}`);
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    !Object.hasOwn(value, 'base_branch')
  ) {
    result.data.base_branch = repo.default_branch;
  }
  return result.data;
}
