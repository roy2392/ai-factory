import { setup, repo } from './helpers.js';
import type { Comment } from '../src/github/client.js';

export function commandSetup(body: string) {
  const result = setup('issue_comment');
  if (result.deps.event.name !== 'issue_comment')
    throw new Error('Expected comment fixture');
  const event = result.deps.event;
  event.comment.body = body;
  const issue = result.state.issues.get(`${repo}#12`)!;
  issue.assignees = [];
  issue.labels = [];
  result.state.comments.set(`${repo}#12`, [
    { id: event.comment.id, body, user: event.comment.user },
  ]);
  return { ...result, event, issue };
}
export function appComment(id: number, body: string): Comment {
  return { id, body, user: { login: 'ai-factory[bot]', type: 'Bot' } };
}
