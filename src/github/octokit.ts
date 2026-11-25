import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { z } from 'zod';
import { parseIssue, parsePullRequest } from '../context.js';
import {
  repoParts,
  type Assignment,
  type Issue,
  type Comment,
  type GitHubClient,
  type Label,
  type LabelResult,
  type MergeMethod,
  type PullRequest,
  type Repository,
  type WorkflowJob,
  type CrossReference,
} from './client.js';

const Client = Octokit.plugin(retry, throttling);
export class OctokitGitHubClient implements GitHubClient {
  async listPullRequestReviews(
    repo: string,
    number: number,
  ): Promise<Comment[]> {
    return (
      await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
        ...repoParts(repo),
        pull_number: number,
        per_page: 100,
      })
    )
      .filter((review) => !!review.submitted_at)
      .map(({ id, body, user, submitted_at }) => ({
        id,
        body: body ?? '',
        created_at: submitted_at,
        user: user ? { login: user.login, type: user.type } : null,
      }));
  }
  async listPullRequestReviewComments(
    repo: string,
    number: number,
  ): Promise<Comment[]> {
    return (
      await this.octokit.paginate(this.octokit.rest.pulls.listReviewComments, {
        ...repoParts(repo),
        pull_number: number,
        per_page: 100,
      })
    ).map(({ id, body, user, created_at }) => ({
      id,
      body: body ?? '',
      created_at,
      user: user ? { login: user.login, type: user.type } : null,
    }));
  }
  // Verified: https://docs.github.com/en/rest/issues/sub-issues#add-sub-issue
  // and https://docs.github.com/en/rest/issues/issue-dependencies#add-a-dependency-an-issue-is-blocked-by
  // URL paths take the issue NUMBER; body sub_issue_id / issue_id take database IDs.
  async listSubIssues(repo: string, number: number): Promise<Issue[]> {
    return (
      await this.octokit.paginate(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
        { ...repoParts(repo), issue_number: number, per_page: 100 },
      )
    ).map(parseIssue);
  }
  async addSubIssue(
    repo: string,
    parent: number,
    childId: number,
  ): Promise<void> {
    if ((await this.listSubIssues(repo, parent)).some((i) => i.id === childId))
      return;
    await this.octokit.request(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues',
      { ...repoParts(repo), issue_number: parent, sub_issue_id: childId },
    );
  }
  async listBlockedBy(repo: string, number: number): Promise<Issue[]> {
    return (
      await this.octokit.paginate(
        'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
        { ...repoParts(repo), issue_number: number, per_page: 100 },
      )
    ).map(parseIssue);
  }
  async addBlockedBy(
    repo: string,
    number: number,
    blockerIssueId: number,
  ): Promise<void> {
    if (
      (await this.listBlockedBy(repo, number)).some(
        (i) => i.id === blockerIssueId,
      )
    )
      return;
    await this.octokit.request(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
      { ...repoParts(repo), issue_number: number, issue_id: blockerIssueId },
    );
  }
  // The command checks trusted task markers before creating an issue.
  async createIssue(repo: string, title: string, body: string): Promise<Issue> {
    return parseIssue(
      (
        await this.octokit.rest.issues.create({
          ...repoParts(repo),
          title,
          body,
          // Resolve uncertain creations through task markers on the next apply,
          // rather than blindly replaying a non-idempotent POST inside the SDK.
          request: { retries: 0 },
        })
      ).data,
    );
  }
  async closeIssue(repo: string, number: number): Promise<void> {
    if ((await this.getIssue(repo, number)).state === 'closed') return;
    await this.octokit.rest.issues.update({
      ...repoParts(repo),
      issue_number: number,
      state: 'closed',
      state_reason: 'completed',
    });
  }
  async listIssuesByLabel(repo: string, label: string): Promise<Issue[]> {
    return this.listIssues(repo, 'open', [label]);
  }
  readonly octokit: InstanceType<typeof Client>;
  private readonly fetch: typeof globalThis.fetch;
  private readonly apiOrigin: string;
  constructor(
    token: string,
    baseUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com',
    fetch?: typeof globalThis.fetch,
  ) {
    this.fetch = fetch ?? globalThis.fetch;
    this.apiOrigin = new URL(baseUrl).origin;
    this.octokit = new Client({
      auth: token || undefined,
      baseUrl,
      ...(fetch ? { request: { fetch } } : {}),
      // Never print Octokit request/error objects: they may contain authorization headers.
      log: { debug() {}, info() {}, warn() {}, error() {} },
      throttle: {
        onRateLimit: (_retryAfter, _options, _octokit, retryCount) =>
          retryCount < 2,
        onSecondaryRateLimit: (_retryAfter, _options, _octokit, retryCount) =>
          retryCount < 2,
      },
    });
  }
  async getRepo(repo: string): Promise<Repository> {
    const { data } = await this.octokit.rest.repos.get(repoParts(repo));
    return { full_name: data.full_name, default_branch: data.default_branch };
  }
  async getIssue(repo: string, number: number): Promise<Issue> {
    return parseIssue(
      (
        await this.octokit.rest.issues.get({
          ...repoParts(repo),
          issue_number: number,
        })
      ).data,
    );
  }
  async listIssueComments(repo: string, number: number): Promise<Comment[]> {
    return (
      await this.octokit.paginate(this.octokit.rest.issues.listComments, {
        ...repoParts(repo),
        issue_number: number,
        per_page: 100,
      })
    ).map(({ id, body, user, created_at }) => ({
      id,
      body: body ?? '',
      created_at,
      user: user ? { login: user.login, type: user.type } : null,
    }));
  }
  async createComment(
    repo: string,
    number: number,
    body: string,
  ): Promise<void> {
    await this.octokit.rest.issues.createComment({
      ...repoParts(repo),
      issue_number: number,
      body,
    });
  }
  async updateComment(repo: string, id: number, body: string): Promise<void> {
    const args = { ...repoParts(repo), comment_id: id };
    if ((await this.octokit.rest.issues.getComment(args)).data.body !== body)
      await this.octokit.rest.issues.updateComment({ ...args, body });
  }
  async addLabels(
    repo: string,
    number: number,
    labels: string[],
  ): Promise<void> {
    const existing = await this.getIssue(repo, number);
    const missing = [...new Set(labels)].filter(
      (label) => !existing.labels.includes(label),
    );
    if (missing.length)
      await this.octokit.rest.issues.addLabels({
        ...repoParts(repo),
        issue_number: number,
        labels: missing,
      });
  }
  async removeLabel(
    repo: string,
    number: number,
    label: string,
  ): Promise<void> {
    if ((await this.getIssue(repo, number)).labels.includes(label))
      await this.octokit.rest.issues.removeLabel({
        ...repoParts(repo),
        issue_number: number,
        name: label,
      });
  }
  async ensureLabels(
    repo: string,
    labels: readonly Label[],
    dryRun = false,
  ): Promise<LabelResult[]> {
    const params = repoParts(repo);
    const existing = await this.octokit.paginate(
      this.octokit.rest.issues.listLabelsForRepo,
      { ...params, per_page: 100 },
    );
    const results: LabelResult[] = [];
    for (const label of labels) {
      const current = existing.find(
        (v) => v.name.toLowerCase() === label.name.toLowerCase(),
      );
      const status = !current
        ? 'created'
        : current.color.toLowerCase() !== label.color.toLowerCase() ||
            (current.description ?? '') !== label.description
          ? 'updated'
          : 'unchanged';
      results.push({ name: label.name, status });
      if (!dryRun && status === 'created')
        await this.octokit.rest.issues.createLabel({ ...params, ...label });
      if (!dryRun && status === 'updated')
        await this.octokit.rest.issues.updateLabel({
          ...params,
          name: current!.name,
          new_name: label.name,
          color: label.color,
          description: label.description,
        });
    }
    return results;
  }
  async getFile(
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    try {
      const { data } = await this.octokit.rest.repos.getContent({
        ...repoParts(repo),
        path,
        ref,
      });
      if (
        Array.isArray(data) ||
        data.type !== 'file' ||
        data.encoding !== 'base64'
      )
        throw new Error('Expected a base64-encoded configuration file');
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'status' in error &&
        error.status === 404
      )
        return null;
      throw error;
    }
  }
  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    return parsePullRequest(
      (
        await this.octokit.rest.pulls.get({
          ...repoParts(repo),
          pull_number: number,
        })
      ).data,
    );
  }
  async listPullRequestsForBranch(
    repo: string,
    branch: string,
  ): Promise<PullRequest[]> {
    const params = repoParts(repo);
    return (
      await this.octokit.paginate(this.octokit.rest.pulls.list, {
        ...params,
        state: 'open',
        head: `${params.owner}:${branch}`,
        per_page: 100,
      })
    ).map(parsePullRequest);
  }
  async enablePullRequestAutoMerge(
    _repo: string,
    nodeId: string,
    method: MergeMethod,
  ): Promise<void> {
    await this.octokit.graphql(
      `mutation($id: ID!, $mergeMethod: PullRequestMergeMethod!) {
      enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: $mergeMethod}) { pullRequest { id } }
    }`,
      { id: nodeId, mergeMethod: method.toUpperCase() },
    );
  }
  async requestReviewers(
    repo: string,
    number: number,
    users: string[],
    teams: string[],
  ): Promise<void> {
    await this.octokit.rest.pulls.requestReviewers({
      ...repoParts(repo),
      pull_number: number,
      reviewers: users,
      team_reviewers: teams,
    });
  }
  async addReaction(
    repo: string,
    commentId: number,
    content: 'eyes',
  ): Promise<void> {
    // GitHub returns the existing reaction when this identity already reacted.
    await this.octokit.rest.reactions.createForIssueComment({
      ...repoParts(repo),
      comment_id: commentId,
      content,
    });
  }
  async assignCopilot(
    repo: string,
    number: number,
    assignment: Assignment,
  ): Promise<void> {
    await this.octokit.request(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/assignees',
      { ...repoParts(repo), issue_number: number, ...assignment },
    );
  }
  async removeAssignees(
    repo: string,
    number: number,
    assignees: string[],
  ): Promise<void> {
    const issue = await this.getIssue(repo, number);
    const current = issue.assignees
      .filter(({ login }) => assignees.includes(login))
      .map(({ login }) => login);
    if (current.length)
      await this.octokit.rest.issues.removeAssignees({
        ...repoParts(repo),
        issue_number: number,
        assignees: current,
      });
  }
  async listWorkflowJobs(repo: string, runId: number): Promise<WorkflowJob[]> {
    return (
      await this.octokit.paginate(
        this.octokit.rest.actions.listJobsForWorkflowRun,
        { ...repoParts(repo), run_id: runId, filter: 'latest', per_page: 100 },
      )
    ).map(({ id, name, conclusion }) => ({ id, name, conclusion }));
  }
  async downloadJobLog(repo: string, jobId: number): Promise<string> {
    const response =
      await this.octokit.rest.actions.downloadJobLogsForWorkflowRun({
        ...repoParts(repo),
        job_id: jobId,
        request: { redirect: 'manual' },
      });
    if (response.status !== 302 || !response.headers.location)
      throw new Error('Job log endpoint did not return a download location');
    const url = new URL(response.headers.location);
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new Error('Invalid job log download location');
    // Signed download URLs are credentials: never log them or forward the App token.
    try {
      const download = await this.fetch(url.href, {
        redirect: 'error',
        signal: AbortSignal.timeout(60000),
      });
      if (!download.ok) throw new Error('Job log download failed');
      return await download.text();
    } catch {
      throw new Error('Job log download failed');
    }
  }
  async listPullRequests(
    repo: string,
    state: 'open' | 'closed' | 'all',
  ): Promise<PullRequest[]> {
    return (
      await this.octokit.paginate(this.octokit.rest.pulls.list, {
        ...repoParts(repo),
        state,
        sort: 'updated',
        direction: 'asc',
        per_page: 100,
      })
    ).map(parsePullRequest);
  }
  async listIssues(
    repo: string,
    state: 'open' | 'closed' | 'all',
    labels: string[],
  ): Promise<Issue[]> {
    return (
      await this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
        ...repoParts(repo),
        state,
        labels: labels.join(','),
        sort: 'updated',
        direction: 'asc',
        per_page: 100,
      })
    )
      .filter((issue) => !issue.pull_request)
      .map(parseIssue);
  }
  async listIssueCrossReferences(
    repo: string,
    number: number,
  ): Promise<CrossReference[]> {
    const events = await this.octokit.paginate(
      this.octokit.rest.issues.listEventsForTimeline,
      { ...repoParts(repo), issue_number: number, per_page: 100 },
    );
    const schema = z.object({
      event: z.literal('cross-referenced'),
      source: z.object({
        issue: z.object({ pull_request: z.object({ url: z.url() }) }),
      }),
    });
    const result = new Map<string, CrossReference>();
    for (const event of events) {
      const parsed = schema.safeParse(event);
      if (!parsed.success) continue;
      const url = new URL(parsed.data.source.issue.pull_request.url);
      const match = /\/repos\/([^/]+)\/([^/]+)\/pulls\/([1-9]\d*)$/.exec(
        url.pathname,
      );
      if (
        url.origin !== this.apiOrigin ||
        !match ||
        !Number.isSafeInteger(Number(match[3]))
      )
        continue;
      const reference = {
        repo: `${match[1]}/${match[2]}`,
        number: Number(match[3]),
      };
      result.set(`${reference.repo}#${reference.number}`, reference);
    }
    return [...result.values()];
  }
}
