import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Comment } from '../github/client.js';
import { findMarkers, marker } from '../markers.js';
import type { Task } from './tasks.js';

export const stateSchema = z.object({
  version: z.literal(1),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  reviewed_hash: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{64}$/)]),
  review_rounds: z.number().int().nonnegative().default(0),
  last_run: z.string(),
});
export type RequirementsState = z.infer<typeof stateSchema>;
export function hashBody(body: string | null): string {
  const normalized = (body ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/g, '');
  return createHash('sha256').update(normalized).digest('hex');
}
// Callers supply only comments attributed to the configured App.
export function parseState(
  comments: readonly Comment[],
): RequirementsState | null {
  for (const c of [...comments].sort((a, b) => b.id - a.id))
    for (const m of findMarkers(c.body, 'req-state')) {
      const parsed = stateSchema.safeParse(m.json);
      if (parsed.success) return parsed.data;
    }
  return null;
}
export function renderState(
  state: RequirementsState,
  tasks: readonly Task[],
): string {
  const rows = tasks.map(
    (t) =>
      `| ${t.id} | #${t.issueNumber} | ${t.state === 'closed' ? 'closed' : t.assignedToCopilot ? 'in-progress' : 'open'} | ${
        t.blockedBy
          .map((id) => {
            const blocker = tasks.find((b) => b.issueId === id);
            return blocker ? `#${blocker.issueNumber}` : `id:${id}`;
          })
          .join(', ') || '—'
      } |`,
  );
  let table =
    '| Task | Issue | Status | Blocked by |\n| --- | --- | --- | --- |';
  for (const row of rows) {
    if (Buffer.byteLength(table + row) > 48000) {
      table += '\n\n[Additional rows omitted.]';
      break;
    }
    table += `\n${row}`;
  }
  return `**Requirements progress.**\n\n${table}\n\n${marker('req-state', {}, state)}`;
}
