import { describe, expect, it } from 'vitest';
import {
  assignToCopilot,
  buildInstructions,
  COPILOT_LOGINS,
  isCopilot,
} from '../src/copilot.js';
import { repo, setup } from './helpers.js';

describe('Copilot assignment', () => {
  it('uses the exact request body with empty optional fields omitted', async () => {
    const { userClient, appClient } = setup();
    await assignToCopilot(userClient, {
      repo,
      issue: 12,
      baseBranch: 'main',
      instructions: 'Do it',
      customAgent: '',
      model: '',
    });
    expect(userClient.writes).toEqual([
      {
        method: 'assignCopilot',
        args: [
          repo,
          12,
          {
            assignees: ['copilot-swe-agent[bot]'],
            agent_assignment: {
              target_repo: repo,
              base_branch: 'main',
              custom_instructions: 'Do it',
            },
          },
        ],
      },
    ]);
    expect(appClient.writes).toEqual([]);
  });
  it('passes configured custom agent and model', async () => {
    const { userClient } = setup();
    await assignToCopilot(userClient, {
      repo,
      issue: 12,
      baseBranch: 'release',
      instructions: 'Do it',
      customAgent: 'implementer',
      model: 'chosen-model',
    });
    expect(userClient.writes[0]?.args[2]).toMatchObject({
      agent_assignment: {
        custom_agent: 'implementer',
        model: 'chosen-model',
        base_branch: 'release',
      },
    });
  });
  it('recognizes every supported login case-insensitively', () => {
    for (const login of COPILOT_LOGINS)
      expect(isCopilot(login.toUpperCase())).toBe(true);
    expect(isCopilot('copilot-user')).toBe(false);
  });
  it('keeps required instructions and short extra text', () => {
    const result = buildInstructions({
      issueUrl: 'https://github.com/acme/widget/issues/12',
      extra: 'Use the existing router.',
    });
    expect(result).toContain('https://github.com/acme/widget/issues/12');
    expect(result).toContain('Follow AGENTS.md');
    expect(result).toContain(
      'Run the build and tests before finishing and report the result honestly in the PR description',
    );
    expect(result).toMatch(/Use the existing router\.$/);
  });
  it('caps instructions at 8,000 characters, truncating only extra with a note', () => {
    const base = buildInstructions({ issueUrl: 'https://example.test/12' });
    const result = buildInstructions({
      issueUrl: 'https://example.test/12',
      extra: 'x'.repeat(9000),
    });
    expect(result.length).toBe(8000);
    expect(result.startsWith(base)).toBe(true);
    expect(result).toMatch(/truncated.*limit\.\]$/);
    expect(
      buildInstructions({
        issueUrl: 'https://example.test/12',
        extra: 'x'.repeat(8000 - base.length - 2),
      }),
    ).toHaveLength(8000);
    expect(() => buildInstructions({ issueUrl: 'x'.repeat(8001) })).toThrow();
  });
});
