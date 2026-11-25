import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { COPILOT_CLI_VERSION } from '../src/copilot-cli.js';

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  if?: string;
}
interface Job {
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps?: Step[];
  uses?: string;
  'timeout-minutes'?: number;
  if?: string;
}
interface Workflow {
  permissions: Record<string, string>;
  concurrency?: { group: string; 'cancel-in-progress': boolean };
  jobs: Record<string, Job>;
}
const workflow = (name: string) =>
  parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8')) as Workflow;

describe('Phase 2 workflow isolation', () => {
  it('gives the Copilot step only its credential and the think job only read permissions', () => {
    const file = workflow('reusable-plan');
    const think = file.jobs.think!;
    expect(file.permissions).toEqual({});
    expect(think.permissions).toEqual({ contents: 'read', issues: 'read' });
    expect(think.env).toBeUndefined();
    const model = think.steps!.find((step) =>
      step.run?.includes('src/run-copilot.ts'),
    )!;
    expect(Object.keys(model.env!)).toEqual(['COPILOT_GITHUB_TOKEN']);
    expect(JSON.stringify(think)).not.toMatch(
      /APP_TOKEN|USER_TOKEN|FACTORY_APP_PRIVATE_KEY|create-github-app-token/,
    );
    const reader = think.steps!.filter((step) => step.env?.GITHUB_TOKEN);
    expect(reader).toHaveLength(1);
    expect(reader[0]?.run).toContain('build-prompt');
    const checkout = think.steps!.find((step) =>
      step.uses?.startsWith('actions/checkout'),
    )!;
    expect(checkout.with?.ref).toBe(
      '${{ github.event.repository.default_branch }}',
    );
    expect(checkout.with?.['persist-credentials']).toBe(false);
    expect(
      think.steps!.some((step) =>
        step.run?.includes(`@github/copilot@${COPILOT_CLI_VERSION}`),
      ),
    ).toBe(true);
    expect(
      think.steps!.some((step) =>
        step.run?.includes('copilot --no-auto-update --help'),
      ),
    ).toBe(true);
  });
  it('serializes callers per issue while giving nested workflows a distinct lock', () => {
    for (const name of ['reusable-dispatch', 'reusable-ai-command']) {
      const file = workflow(name);
      expect(file.concurrency).toEqual({
        group: 'ai-factory-issue-${{ github.event.issue.number }}',
        'cancel-in-progress': false,
      });
      expect(file.jobs.plan?.uses).toBe(
        './.github/workflows/reusable-plan.yml',
      );
      const route = file.jobs.route ?? file.jobs.dispatch;
      expect(route?.['timeout-minutes']).toBe(5);
      const upload = route!.steps!.find((step) =>
        step.uses?.startsWith('actions/upload-artifact'),
      )!;
      expect(upload.with?.path).not.toMatch(/\.git\/|node_modules/);
      expect(upload.with?.overwrite).toBe(true);
      expect(upload.with?.name).not.toContain('run_attempt');
    }
    const shared = workflow('reusable-plan');
    expect(shared.concurrency?.group).not.toBe(
      workflow('reusable-dispatch').concurrency?.group,
    );
    expect(shared.jobs.think?.['timeout-minutes']).toBe(30);
    expect(shared.jobs.publish?.['timeout-minutes']).toBe(5);
  });
  it('publishes on a failed think job and never executes downloaded model output', () => {
    const publish = workflow('reusable-plan').jobs.publish!;
    expect(publish.if).toContain('always()');
    expect(publish.if).toContain('!cancelled()');
    expect(publish.permissions).toEqual({ issues: 'write' });
    const commands = publish.steps!.map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('post-plan');
    expect(commands).toContain('post-answer');
    expect(commands).not.toMatch(
      /bash .*\.model-output|source .*\.model-output|eval /,
    );
  });
});

describe('Phase 3 workflow isolation', () => {
  it.each(['self-heal', 'watchdog'])(
    'checks out only trusted factory code for %s',
    (command) => {
      const file = workflow(`reusable-${command}`);
      const job = file.jobs[command]!;
      expect(file.permissions).toEqual({});
      expect(file.concurrency?.['cancel-in-progress']).toBe(false);
      const checkouts = job.steps!.filter((step) =>
        step.uses?.startsWith('actions/checkout'),
      );
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]?.with).toMatchObject({
        repository: '${{ inputs.factory_repo }}',
        ref: '${{ inputs.factory_ref }}',
        path: '.factory',
        'persist-credentials': false,
      });
      expect(JSON.stringify(job.steps)).not.toMatch(
        /head_sha|head\.sha|pull_request\.head|workflow_run\.head_repository/,
      );
      const execution = job.steps!.find((step) =>
        step.run?.includes(`src/cli.ts ${command}`),
      )!;
      expect(execution.env?.APP_TOKEN).toBe('${{ steps.app.outputs.token }}');
      expect(JSON.stringify(job)).not.toContain('COPILOT_CLI_TOKEN');
      if (command === 'self-heal') {
        expect(job.permissions).toEqual({
          actions: 'read',
          'pull-requests': 'write',
          issues: 'write',
        });
        expect(job['timeout-minutes']).toBe(10);
        expect(execution.env?.USER_TOKEN).toBe(
          '${{ secrets.COPILOT_ASSIGN_TOKEN }}',
        );
        expect(file.concurrency?.group).toBe(
          'ai-factory-pr-${{ github.event.workflow_run.head_branch }}',
        );
      } else {
        expect(job.permissions).toEqual({
          issues: 'write',
          'pull-requests': 'write',
        });
        expect(job['timeout-minutes']).toBe(15);
        expect(JSON.stringify(file)).not.toMatch(
          /USER_TOKEN|COPILOT_ASSIGN_TOKEN/,
        );
      }
    },
  );
});
