import type { FactoryEvent } from '../context.js';
import type { Comment } from '../github/client.js';
import { findMarkers } from '../markers.js';

export interface RouteOutput {
  mode: 'done' | 'ask' | 'plan';
  issue: number;
  comment_id: number;
}
export function routeOutput(
  event: FactoryEvent,
  mode: RouteOutput['mode'] = 'done',
): RouteOutput {
  return {
    mode,
    issue: 'issue' in event ? event.issue.number : 0,
    comment_id: event.name === 'issue_comment' ? event.comment.id : 0,
  };
}
export function sourceOf(event: FactoryEvent): string {
  if (event.name === 'issue_comment') return `comment-${event.comment.id}`;
  if (event.name === 'issues')
    return `issue-${event.issue.number}${event.runId ? `-run-${event.runId}` : ''}`;
  throw new Error('An issue or issue_comment event is required');
}
export function factoryComments(
  comments: Comment[],
  event: FactoryEvent,
): Comment[] {
  const login = (event.factoryLogin ?? 'ai-factory[bot]').toLowerCase();
  return comments.filter(
    (comment) =>
      comment.user?.type === 'Bot' &&
      comment.user.login.toLowerCase() === login,
  );
}
export function hasSource(
  comment: Comment,
  kind: string,
  source: string,
): boolean {
  return findMarkers(comment.body, kind).some((m) => m.attrs.source === source);
}
