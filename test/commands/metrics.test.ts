import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { main } from '../../src/cli.js';
import { FakeGitHubClient, FakeState } from '../../src/github/fake.js';
import { computeMetrics, renderMetrics } from '../../src/metrics.js';
import { metricsFixture, NOW } from '../metrics-helpers.js';

function fixture() {
  const input = metricsFixture(),
    state = new FakeState();
  for (const pr of input.prs)
    state.pullRequests.set(`${input.repo}#${pr.number}`, pr);
  for (const issue of input.issues)
    state.issues.set(`${input.repo}#${issue.number}`, issue);
  for (const [n, c] of input.comments)
    state.comments.set(`${input.repo}#${n}`, c);
  for (const [n, c] of input.reviewFeedback)
    state.reviews.set(`${input.repo}#${n}`, c);
  const client = new FakeGitHubClient(state);
  return {
    input,
    state,
    client,
    env: {
      APP_TOKEN: 'fixture-app-token',
      FACTORY_APP_LOGIN: input.factoryLogin,
      COPILOT_BOT_LOGIN: input.botLogin,
    },
  };
}
it('runs the whole metrics CLI read-only and writes matching JSON, Markdown and job summary without an event payload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-metrics-'));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  try {
    const { input, state, client, env } = fixture();
    const factory = vi.fn(() => client),
      messages: string[] = [];
    const getConfig = vi.spyOn(client, 'getFile');
    const summary = join(dir, 'summary.md');
    const code = await main(
      ['metrics', '--repo', input.repo, '--since', '30d', '--output-dir', dir],
      { ...env, GITHUB_STEP_SUMMARY: summary },
      (m) => messages.push(m),
      factory,
    );
    expect(code).toBe(0);
    expect(factory).toHaveBeenCalledExactlyOnceWith(
      'fixture-app-token',
      undefined,
    );
    expect(getConfig).not.toHaveBeenCalled();
    const expected = computeMetrics(input);
    expect(JSON.parse(readFileSync(join(dir, 'metrics.json'), 'utf8'))).toEqual(
      expected,
    );
    expect(messages).toEqual([renderMetrics(expected)]);
    expect(readFileSync(summary, 'utf8')).toBe(`${renderMetrics(expected)}\n`);
    expect(state.writes).toEqual([]);
  } finally {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('dry-run prints the metrics without writing files or a summary; invalid durations fail before GitHub reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-metrics-'));
  try {
    const { input, state, client, env } = fixture();
    const read = vi.spyOn(client, 'listPullRequests');
    expect(
      await main(
        [
          'metrics',
          '--repo',
          input.repo,
          '--since',
          'nonsense',
          '--output-dir',
          dir,
        ],
        env,
        () => {},
        () => client,
      ),
    ).toBe(1);
    expect(read).not.toHaveBeenCalled();
    const summary = join(dir, 'summary.md');
    expect(
      await main(
        ['metrics', '--repo', input.repo, '--dry-run', '--output-dir', dir],
        { ...env, GITHUB_STEP_SUMMARY: summary },
        () => {},
        () => client,
      ),
    ).toBe(0);
    expect(existsSync(join(dir, 'metrics.json'))).toBe(false);
    expect(existsSync(summary)).toBe(false);
    expect(state.writes).toEqual([]);
    expect(
      await main(
        ['metrics', '--since', '30d'],
        env,
        () => {},
        () => client,
      ),
    ).toBe(1);
    expect(
      await main(
        ['labels', '--repo', input.repo, '--since', '30d'],
        env,
        () => {},
        () => client,
      ),
    ).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('refuses output symlinks and leaves prior output intact when a GitHub read fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-metrics-'));
  try {
    const { input, client, env } = fixture();
    const outside = join(dir, 'keep.json'),
      output = join(dir, 'metrics.json');
    writeFileSync(outside, 'untouched');
    symlinkSync(outside, output);
    expect(
      await main(
        ['metrics', '--repo', input.repo, '--output-dir', dir],
        env,
        () => {},
        () => client,
      ),
    ).toBe(1);
    expect(readFileSync(outside, 'utf8')).toBe('untouched');
    rmSync(output);
    writeFileSync(output, 'prior report');
    vi.spyOn(client, 'listPullRequestReviews').mockRejectedValue(
      new Error('read failed'),
    );
    // Keep the fixture's merges inside the actual command window for this failure.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    expect(
      await main(
        ['metrics', '--repo', input.repo, '--output-dir', dir],
        env,
        () => {},
        () => client,
      ),
    ).toBe(1);
    expect(readFileSync(output, 'utf8')).toBe('prior report');
  } finally {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
});
