export interface Repository {
  full_name: string;
  default_branch: string;
}

export interface Actor {
  login: string;
  type: string;
}

export interface Issue {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  user: Actor | null;
  author_association: string;
  body: string | null;
  labels: string[];
  assignees: { login: string }[];
  pull_request?: unknown;
}

export interface PullRequest {
  number: number;
  node_id: string;
  state: 'open' | 'closed';
  user: Actor | null;
  body: string | null;
  draft: boolean;
  head: { ref: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
  auto_merge: { merge_method: string } | null;
  labels: string[];
  requested_reviewers: { login: string }[];
  requested_teams: { slug: string }[];
}

export interface Comment {
  id: number;
  body: string;
}
export interface Label {
  name: string;
  color: string;
  description: string;
}
export interface LabelResult {
  name: string;
  status: 'created' | 'updated' | 'unchanged';
}
export type MergeMethod = 'merge' | 'squash' | 'rebase';
export interface Assignment {
  assignees: string[];
  agent_assignment: {
    target_repo: string;
    base_branch: string;
    custom_instructions: string;
    custom_agent?: string;
    model?: string;
  };
}

export interface GitHubClient {
  getIssue(repo: string, number: number): Promise<Issue>;
  listIssueComments(repo: string, number: number): Promise<Comment[]>;
  createComment(repo: string, number: number, body: string): Promise<void>;
  updateComment(repo: string, id: number, body: string): Promise<void>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  removeLabel(repo: string, number: number, label: string): Promise<void>;
  ensureLabels(
    repo: string,
    labels: readonly Label[],
    dryRun?: boolean,
  ): Promise<LabelResult[]>;
  getFile(repo: string, path: string, ref: string): Promise<string | null>;
  getRepo(repo: string): Promise<Repository>;
  getPullRequest(repo: string, number: number): Promise<PullRequest>;
  listPullRequestsForBranch(
    repo: string,
    branch: string,
  ): Promise<PullRequest[]>;
  enablePullRequestAutoMerge(
    repo: string,
    nodeId: string,
    method: MergeMethod,
  ): Promise<void>;
  requestReviewers(
    repo: string,
    number: number,
    users: string[],
    teams: string[],
  ): Promise<void>;
  addReaction(repo: string, commentId: number, content: 'eyes'): Promise<void>;
  assignCopilot(
    repo: string,
    number: number,
    assignment: Assignment,
  ): Promise<void>;
}

export function repoParts(repo: string): { owner: string; repo: string } {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo);
  if (!match?.[1] || !match[2])
    throw new Error('Repository must be OWNER/REPO');
  return { owner: match[1], repo: match[2] };
}
