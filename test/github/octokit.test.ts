import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { OctokitGitHubClient } from '../../src/github/octokit.js';
import { repo } from '../helpers.js';

function transport(
  responses: {
    data: unknown;
    status?: number;
    headers?: Record<string, string>;
  }[],
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    calls.push({ url: String(input), init });
    const response = responses.shift();
    if (!response) throw new Error('Unexpected request in test');
    return new Response(JSON.stringify(response.data), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json', ...response.headers },
    });
  });
  return {
    client: new OctokitGitHubClient(
      'test-token',
      'https://github.example.test/api/v3',
      fetch,
    ),
    calls,
  };
}

describe('Octokit transport (mock fetch, no network)', () => {
  it('removes only requested current assignees using DELETE, preserving human assignments', async () => {
    const payload = JSON.parse(
      readFileSync(
        new URL('../fixtures/issues.opened.json', import.meta.url),
        'utf8',
      ),
    ) as { issue: Record<string, unknown> };
    payload.issue.assignees = [{ login: 'Copilot' }, { login: 'human' }];
    const { client, calls } = transport([
      { data: payload.issue },
      { data: {} },
    ]);
    await client.removeAssignees(repo, 12, [
      'Copilot',
      'copilot-swe-agent[bot]',
    ]);
    expect(calls[1]?.init?.method).toBe('DELETE');
    expect(calls[1]?.url).toContain('/issues/12/assignees');
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      assignees: ['Copilot'],
    });
  });
  it('retains comment author identity for trusted plan/state selection', async () => {
    const { client } = transport([
      {
        data: [
          {
            id: 1,
            body: '<!-- ai-factory:plan -->',
            user: { login: 'ai-factory[bot]', type: 'Bot' },
          },
        ],
      },
    ]);
    expect((await client.listIssueComments(repo, 12))[0]?.user).toEqual({
      login: 'ai-factory[bot]',
      type: 'Bot',
    });
  });
  it('sends Copilot assignment to the assignees endpoint with the full agent payload', async () => {
    const { client, calls } = transport([{ data: {} }]);
    const assignment = {
      assignees: ['copilot-swe-agent[bot]'],
      agent_assignment: {
        target_repo: repo,
        base_branch: 'main',
        custom_instructions: 'Follow AGENTS.md',
        custom_agent: 'implementer',
      },
    };
    await client.assignCopilot(repo, 12, assignment);
    expect(calls[0]?.url).toBe(
      'https://github.example.test/api/v3/repos/acme/widget/issues/12/assignees',
    );
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual(assignment);
  });
  it('uses GraphQL with the PR node ID and uppercase merge method on Enterprise', async () => {
    const { client, calls } = transport([
      {
        data: {
          data: {
            enablePullRequestAutoMerge: { pullRequest: { id: 'PR_123' } },
          },
        },
      },
    ]);
    await client.enablePullRequestAutoMerge(repo, 'PR_123', 'squash');
    expect(calls[0]?.url).toBe('https://github.example.test/api/graphql');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      query: expect.stringContaining('enablePullRequestAutoMerge'),
      variables: { id: 'PR_123', mergeMethod: 'SQUASH' },
    });
  });
  it('decodes the config at the requested ref; only 404 becomes missing', async () => {
    const { client, calls } = transport([
      {
        data: {
          type: 'file',
          encoding: 'base64',
          content: Buffer.from('version: 1').toString('base64'),
        },
      },
      { data: { message: 'Not Found' }, status: 404 },
      { data: { message: 'Forbidden' }, status: 403 },
    ]);
    expect(await client.getFile(repo, '.github/ai-factory.yml', 'main')).toBe(
      'version: 1',
    );
    expect(calls[0]?.url).toContain('ref=main');
    expect(
      await client.getFile(repo, '.github/ai-factory.yml', 'main'),
    ).toBeNull();
    await expect(
      client.getFile(repo, '.github/ai-factory.yml', 'main'),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('paginates comments so old dispatch markers are not missed', async () => {
    const { client, calls } = transport([
      {
        data: [{ id: 1, body: 'first' }],
        headers: {
          link: '<https://github.example.test/api/v3/repos/acme/widget/issues/12/comments?page=2>; rel="next"',
        },
      },
      {
        data: [{ id: 2, body: '<!-- ai-factory:dispatch state=assigned -->' }],
      },
    ]);
    expect(await client.listIssueComments(repo, 12)).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
  it('creates/updates only changed labels and honors dry-run', async () => {
    const labels = [
      { name: 'keep', color: 'aabbcc', description: 'keep' },
      { name: 'edit', color: '123456', description: 'old' },
    ];
    const desired = [
      { name: 'keep', color: 'AABBCC', description: 'keep' },
      { name: 'edit', color: '654321', description: 'new' },
      { name: 'create', color: '000000', description: 'new' },
    ];
    const { client, calls } = transport([
      { data: labels },
      { data: {} },
      { data: {} },
      { data: labels },
    ]);
    expect(await client.ensureLabels(repo, desired)).toEqual([
      { name: 'keep', status: 'unchanged' },
      { name: 'edit', status: 'updated' },
      { name: 'create', status: 'created' },
    ]);
    expect(calls.map((v) => v.init?.method)).toEqual(['GET', 'PATCH', 'POST']);
    await client.ensureLabels(repo, desired, true);
    expect(calls).toHaveLength(4);
    expect(calls[3]?.init?.method).toBe('GET');
  });
  it('normalizes real-shaped issue and PR payloads', async () => {
    const issue = JSON.parse(
      readFileSync(
        new URL('../fixtures/issues.opened.json', import.meta.url),
        'utf8',
      ),
    ) as { issue: unknown };
    const pr = JSON.parse(
      readFileSync(
        new URL(
          '../fixtures/pull_request_target.ready_for_review.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as { pull_request: unknown };
    const { client } = transport([
      { data: issue.issue },
      { data: pr.pull_request },
    ]);
    expect(await client.getIssue(repo, 12)).toMatchObject({
      number: 12,
      labels: [],
    });
    expect(await client.getPullRequest(repo, 13)).toMatchObject({
      number: 13,
      draft: false,
      labels: [],
    });
  });
});
