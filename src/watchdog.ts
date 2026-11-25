import type { Comment } from './github/client.js';
export { linkedIssues } from './links.js';

export function isStale(
  updatedAt: string | undefined,
  now: Date,
  hours: number,
): boolean {
  const updated = Date.parse(updatedAt ?? '');
  return (
    Number.isFinite(updated) &&
    Number.isFinite(now.getTime()) &&
    hours > 0 &&
    now.getTime() - updated > hours * 3600000
  );
}
export function needsStaleComment(
  markers: readonly Pick<Comment, 'created_at'>[],
  lastUpdate: string | undefined,
): boolean {
  const updated = Date.parse(lastUpdate ?? '');
  return (
    Number.isFinite(updated) &&
    !markers.some((m) => Date.parse(m.created_at ?? '') >= updated)
  );
}
