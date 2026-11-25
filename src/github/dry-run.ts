import type { GitHubClient } from './client.js';

const writes = new Set<keyof GitHubClient>([
  'createIssue',
  'closeIssue',
  'addSubIssue',
  'addBlockedBy',
  'createComment',
  'updateComment',
  'addLabels',
  'removeLabel',
  'enablePullRequestAutoMerge',
  'requestReviewers',
  'addReaction',
  'assignCopilot',
  'removeAssignees',
]);

export function dryRunClient(
  client: GitHubClient,
  log: (message: string) => void,
): GitHubClient {
  return new Proxy(client, {
    get(target, key: keyof GitHubClient) {
      if (key === 'ensureLabels')
        return async (...args: Parameters<GitHubClient['ensureLabels']>) => {
          const results = await target.ensureLabels(args[0], args[1], true);
          for (const result of results)
            if (result.status !== 'unchanged')
              log(`[dry-run] ${result.status} label ${result.name}`);
          return results;
        };
      if (writes.has(key))
        return (...args: unknown[]) => {
          log(`[dry-run] ${key} ${JSON.stringify(args)}`);
          return Promise.resolve();
        };
      return target[key].bind(target);
    },
  });
}
