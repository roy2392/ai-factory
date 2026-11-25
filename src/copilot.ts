import type { GitHubClient } from './github/client.js';

export const COPILOT_LOGINS = new Set([
  'Copilot',
  'copilot-swe-agent',
  'copilot-swe-agent[bot]',
]);
export function isCopilot(login: string): boolean {
  return [...COPILOT_LOGINS].some(
    (candidate) => candidate.toLowerCase() === login.toLowerCase(),
  );
}

export interface CopilotOptions {
  repo: string;
  issue: number;
  baseBranch: string;
  customAgent?: string;
  model?: string;
  instructions: string;
}

// The caller supplies the dedicated COPILOT_ASSIGN_TOKEN user client, never the App client.
export async function assignToCopilot(
  userClient: GitHubClient,
  options: CopilotOptions,
): Promise<void> {
  await userClient.assignCopilot(options.repo, options.issue, {
    assignees: ['copilot-swe-agent[bot]'],
    agent_assignment: {
      target_repo: options.repo,
      base_branch: options.baseBranch,
      custom_instructions: options.instructions,
      ...(options.customAgent ? { custom_agent: options.customAgent } : {}),
      ...(options.model ? { model: options.model } : {}),
    },
  });
}

export function buildInstructions({
  issueUrl,
  extra,
}: {
  issueUrl: string;
  extra?: string;
}): string {
  const required = `Implement the issue: ${issueUrl}\n\nFollow AGENTS.md.\n\nRun the build and tests before finishing and report the result honestly in the PR description.`;
  if (required.length > 8000)
    throw new Error('Issue URL exceeds the instruction budget');
  if (!extra) return required;
  const full = `${required}\n\n${extra}`;
  if (full.length <= 8000) return full;
  const note =
    '\n[Additional instructions truncated to fit the 8,000-character limit.]';
  const remaining = 8000 - required.length - 2 - note.length;
  if (remaining < 0) return required;
  return `${required}\n\n${extra.slice(0, remaining)}${note}`;
}
