import type {
  Assignment,
  Comment,
  GitHubClient,
  Issue,
  Label,
  LabelResult,
  MergeMethod,
  PullRequest,
  Repository,
} from './client.js';

export interface WriteCall {
  method: string;
  args: unknown[];
}
export class FakeState {
  repositories = new Map<string, Repository>();
  issues = new Map<string, Issue>();
  pullRequests = new Map<string, PullRequest>();
  comments = new Map<string, Comment[]>();
  labels = new Map<string, Label[]>();
  files = new Map<string, string>();
  reactions = new Set<string>();
  writes: (WriteCall & { identity: string })[] = [];
}

export class FakeGitHubClient implements GitHubClient {
  readonly writes: WriteCall[] = [];
  constructor(
    readonly state = new FakeState(),
    readonly identity = 'app',
  ) {}
  private record(method: string, ...args: unknown[]): void {
    const call = structuredClone({ method, args });
    this.writes.push(call);
    this.state.writes.push({ ...call, identity: this.identity });
  }
  private required<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('Fake resource not found');
    return structuredClone(value);
  }
  async getRepo(repo: string): Promise<Repository> {
    return this.required(this.state.repositories.get(repo));
  }
  async getIssue(repo: string, number: number): Promise<Issue> {
    return this.required(this.state.issues.get(`${repo}#${number}`));
  }
  async getPullRequest(repo: string, number: number): Promise<PullRequest> {
    return this.required(this.state.pullRequests.get(`${repo}#${number}`));
  }
  async listIssueComments(repo: string, number: number): Promise<Comment[]> {
    return structuredClone(this.state.comments.get(`${repo}#${number}`) ?? []);
  }
  async createComment(
    repo: string,
    number: number,
    body: string,
  ): Promise<void> {
    this.record('createComment', repo, number, body);
    const key = `${repo}#${number}`;
    this.state.comments.set(key, [
      ...(this.state.comments.get(key) ?? []),
      { id: this.state.writes.length, body },
    ]);
  }
  async updateComment(repo: string, id: number, body: string): Promise<void> {
    for (const [key, comments] of this.state.comments) {
      const comment = key.startsWith(`${repo}#`)
        ? comments.find((c) => c.id === id)
        : undefined;
      if (comment) {
        if (comment.body !== body) {
          this.record('updateComment', repo, id, body);
          comment.body = body;
        }
        return;
      }
    }
    throw new Error('Fake comment not found');
  }
  async addLabels(
    repo: string,
    number: number,
    labels: string[],
  ): Promise<void> {
    const item =
      this.state.issues.get(`${repo}#${number}`) ??
      this.state.pullRequests.get(`${repo}#${number}`);
    if (!item) throw new Error('Fake resource not found');
    const missing = [...new Set(labels)].filter(
      (label) => !item.labels.includes(label),
    );
    if (missing.length) {
      this.record('addLabels', repo, number, missing);
      item.labels.push(...missing);
    }
  }
  async removeLabel(
    repo: string,
    number: number,
    label: string,
  ): Promise<void> {
    const item =
      this.state.issues.get(`${repo}#${number}`) ??
      this.state.pullRequests.get(`${repo}#${number}`);
    if (!item) throw new Error('Fake resource not found');
    if (item.labels.includes(label)) {
      this.record('removeLabel', repo, number, label);
      item.labels = item.labels.filter((v) => v !== label);
    }
  }
  async ensureLabels(
    repo: string,
    labels: readonly Label[],
    dryRun = false,
  ): Promise<LabelResult[]> {
    const existing = this.state.labels.get(repo) ?? [];
    const results: LabelResult[] = [];
    for (const label of labels) {
      const current = existing.find(
        (v) => v.name.toLowerCase() === label.name.toLowerCase(),
      );
      const status = !current
        ? 'created'
        : current.color.toLowerCase() !== label.color.toLowerCase() ||
            current.description !== label.description
          ? 'updated'
          : 'unchanged';
      results.push({ name: label.name, status });
      if (!dryRun && status !== 'unchanged') {
        this.record(
          status === 'created' ? 'createLabel' : 'updateLabel',
          repo,
          label,
        );
        if (current) Object.assign(current, label);
        else existing.push(structuredClone(label));
      }
    }
    if (!dryRun) this.state.labels.set(repo, existing);
    return results;
  }
  async getFile(
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    return this.state.files.get(`${repo}:${ref}:${path}`) ?? null;
  }
  async listPullRequestsForBranch(
    repo: string,
    branch: string,
  ): Promise<PullRequest[]> {
    return structuredClone(
      [...this.state.pullRequests.values()].filter(
        (pr) =>
          pr.state === 'open' &&
          pr.base.repo.full_name === repo &&
          pr.head.repo?.full_name === repo &&
          pr.head.ref === branch,
      ),
    );
  }
  async enablePullRequestAutoMerge(
    repo: string,
    nodeId: string,
    method: MergeMethod,
  ): Promise<void> {
    const pr = [...this.state.pullRequests.values()].find(
      (v) => v.node_id === nodeId && v.base.repo.full_name === repo,
    );
    if (!pr) throw new Error('Fake PR not found');
    if (!pr.auto_merge) {
      this.record('enablePullRequestAutoMerge', repo, nodeId, method);
      pr.auto_merge = { merge_method: method };
    }
  }
  async requestReviewers(
    repo: string,
    number: number,
    users: string[],
    teams: string[],
  ): Promise<void> {
    const pr = this.state.pullRequests.get(`${repo}#${number}`);
    if (!pr) throw new Error('Fake PR not found');
    this.record('requestReviewers', repo, number, users, teams);
    pr.requested_reviewers.push(...users.map((login) => ({ login })));
    pr.requested_teams.push(...teams.map((slug) => ({ slug })));
  }
  async addReaction(
    repo: string,
    commentId: number,
    content: 'eyes',
  ): Promise<void> {
    const key = `${repo}:${commentId}:${content}:${this.identity}`;
    if (!this.state.reactions.has(key)) {
      this.record('addReaction', repo, commentId, content);
      this.state.reactions.add(key);
    }
  }
  async assignCopilot(
    repo: string,
    number: number,
    assignment: Assignment,
  ): Promise<void> {
    const issue = this.state.issues.get(`${repo}#${number}`);
    if (!issue) throw new Error('Fake issue not found');
    this.record('assignCopilot', repo, number, assignment);
    issue.assignees.push(...assignment.assignees.map((login) => ({ login })));
  }
}
