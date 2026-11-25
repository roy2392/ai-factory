import { z } from 'zod';
import { findCycle } from './graph.js';

export const taskSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,40}$/),
    title: z.string().trim().min(1).max(120),
    body: z
      .string()
      .min(1)
      .max(20000)
      .refine((s) => !!s.trim(), 'Body must not be blank')
      .refine(
        (s) => !/<!--\s*ai-factory:/i.test(s),
        'Body must not contain factory markers',
      ),
    depends_on: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).max(10),
  })
  .strict();
export type ProposedTask = z.infer<typeof taskSchema>;
export function validateIssuesJson(
  raw: string,
  existingIds: Set<string>,
  maxTasks: number,
): { ok: true; tasks: ProposedTask[] } | { ok: false; errors: string[] } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ['Output must be valid JSON'] };
  }
  if (!Array.isArray(value))
    return { ok: false, errors: ['Output must be a JSON array'] };
  const errors: string[] = [];
  if (value.length > Math.min(15, maxTasks))
    errors.push(`At most ${Math.min(15, maxTasks)} tasks are allowed`);
  const tasks: ProposedTask[] = [];
  const nodes: { id: string; depends_on: string[] }[] = [];
  value.forEach((v: unknown, i) => {
    const parsed = taskSchema.safeParse(v);
    if (parsed.success) tasks.push(parsed.data);
    else
      for (const issue of parsed.error.issues)
        errors.push(`Task ${i + 1} ${issue.path.join('.')}: ${issue.message}`);
    // Continue semantic checks even if a title/body/schema field was invalid.
    const node = z
      .object({ id: taskSchema.shape.id, depends_on: z.array(z.string()) })
      .safeParse(v);
    if (node.success) nodes.push(node.data);
  });
  const ids = new Set<string>();
  for (const task of nodes) {
    if (ids.has(task.id)) errors.push(`Duplicate id: ${task.id}`);
    if (existingIds.has(task.id)) errors.push(`Existing id: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of nodes)
    for (const dep of task.depends_on)
      if (!ids.has(dep) && !existingIds.has(dep))
        errors.push(`Unknown dependency ${dep} for ${task.id}`);
  const cycle = findCycle(nodes);
  if (cycle) errors.push(`Dependency cycle: ${cycle.join(' -> ')}`);
  return errors.length ? { ok: false, errors } : { ok: true, tasks };
}
