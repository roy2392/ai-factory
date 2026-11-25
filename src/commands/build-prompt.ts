import { lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { askPrompt, planPrompt } from '../prompts.js';
import type { ThinkMode } from '../copilot-cli.js';
import { parseAiCommand } from './parse.js';
import type { Dependencies } from './types.js';

export async function run(
  { event, appClient }: Dependencies,
  {
    mode,
    outputDir = 'out',
    dryRun = false,
  }: { mode: ThinkMode; outputDir?: string; dryRun?: boolean },
): Promise<void> {
  if (mode !== 'ask' && mode !== 'plan')
    throw new Error('build-prompt only supports ask or plan');
  if (event.name !== 'issues' && event.name !== 'issue_comment')
    throw new Error('build-prompt requires an issue event');
  if (event.issue.pull_request)
    throw new Error('Cannot build prompts for pull request comments');
  const issue = await appClient.getIssue(event.repo, event.issue.number);
  const comments = await appClient.listIssueComments(event.repo, issue.number);
  let content: string;
  if (mode === 'ask') {
    const command =
      event.name === 'issue_comment'
        ? parseAiCommand(event.comment.body)
        : null;
    if (command?.cmd !== 'ask')
      throw new Error('Ask mode requires an /ai ask comment');
    content = askPrompt(issue, comments, command.arg);
  } else {
    const repo = await appClient.getRepo(event.repo);
    const agents = await appClient.getFile(
      event.repo,
      'AGENTS.md',
      repo.default_branch,
    );
    content = planPrompt(issue, comments, agents ?? '');
  }
  if (!dryRun) {
    mkdirSync(outputDir, { recursive: true });
    if (
      !lstatSync(outputDir).isDirectory() ||
      lstatSync(outputDir).isSymbolicLink()
    )
      throw new Error('Output directory must be a real directory');
    // Never publish a pre-existing repository artifact as a new model response.
    for (const file of ['plan.md', 'answer.md', 'prompt.md', 'mode.txt'])
      rmSync(join(outputDir, file), { force: true });
    writeFileSync(join(outputDir, 'prompt.md'), content);
    writeFileSync(join(outputDir, 'mode.txt'), mode);
  }
}
