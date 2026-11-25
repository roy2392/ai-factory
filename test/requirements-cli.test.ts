import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { fixtureEnv } from './helpers.js';
import { proposed, requirementsSetup } from './requirements/helpers.js';
import { readArtifact, scan } from '../src/commands/requirements.js';
import { hashBody } from '../src/requirements/state.js';
it('scans via CLI into fixed inputs and matrix JSON, then applies only the validated issues artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-req-'));
  try {
    const { appClient, userClient, state } = requirementsSetup();
    const factory = vi.fn((token: string) =>
      token === 'user' ? userClient : appClient,
    );
    const env = {
      ...fixtureEnv('schedule'),
      APP_TOKEN: 'app',
      USER_TOKEN: 'user',
      GITHUB_OUTPUT: join(dir, 'outputs'),
    };
    const inputDir = join(dir, 'inputs');
    expect(
      await main(
        ['requirements', '--output-dir', inputDir],
        env,
        () => {},
        factory,
      ),
    ).toBe(0);
    expect(factory.mock.calls.map((c) => c[0])).toEqual(['app']);
    const output = readFileSync(env.GITHUB_OUTPUT, 'utf8');
    expect(output).toBe('plan=[{"issue":12,"mode":"analyze"}]\n');
    const input = join(inputDir, '12');
    expect(readFileSync(join(input, 'requirements.md'), 'utf8')).toBe(
      'Build four related features',
    );
    expect(readFileSync(join(input, 'mode.txt'), 'utf8')).toBe('analyze');
    expect(
      JSON.parse(readFileSync(join(input, 'existing-tasks.json'), 'utf8')),
    ).toEqual([]);
    const prompt = readFileSync(join(input, 'prompt.md'), 'utf8');
    expect(prompt).toContain('Write only out/issues.json');
    expect(prompt).toContain('untrusted');
    const model = join(dir, 'model');
    mkdirSync(model);
    writeFileSync(join(model, 'issues.json'), JSON.stringify([proposed('a')]));
    writeFileSync(join(model, 'ignored.sh'), 'do not execute');
    expect(
      await main(
        ['requirements-apply', '--input-dir', input, '--output-dir', model],
        env,
        () => {},
        factory,
      ),
    ).toBe(0);
    expect(state.writes.filter((w) => w.method === 'createIssue')).toHaveLength(
      1,
    );
    expect(factory.mock.calls.map((c) => c[0])).toEqual(['app', 'app', 'user']);
    const writes = state.writes.length;
    expect(
      await main(
        ['requirements-apply', '--input-dir', input, '--output-dir', model],
        env,
        () => {},
        factory,
      ),
    ).toBe(0);
    expect(state.writes).toHaveLength(writes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('scan dry-run writes no files or GitHub state; unsafe artifacts are rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-req-'));
  try {
    const { appClient, state } = requirementsSetup();
    expect(
      await main(
        ['requirements', '--dry-run'],
        fixtureEnv('schedule'),
        () => {},
        () => appClient,
      ),
    ).toBe(0);
    expect(state.writes).toEqual([]);
    writeFileSync(join(dir, 'actual.json'), '[]');
    symlinkSync(join(dir, 'actual.json'), join(dir, 'issues.json'));
    expect(() => readArtifact(dir, 'issues.json')).toThrow('Invalid');
    expect(() => readArtifact(dir, 'actual.json', 1)).toThrow('oversized');
    expect(
      await main(
        ['requirements-apply', '--dry-run'],
        fixtureEnv('schedule'),
        () => {},
        () => appClient,
      ),
    ).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('builds prompt inputs and their snapshot hash from the same fresh parent read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-req-'));
  try {
    const { deps, appClient } = requirementsSetup();
    const get = appClient.getIssue.bind(appClient);
    vi.spyOn(appClient, 'getIssue').mockImplementation(async (...args) => ({
      ...(await get(...args)),
      body: 'Edited since the list response',
    }));
    const [snapshot] = await scan(deps, dir);
    expect(readFileSync(join(dir, '12/requirements.md'), 'utf8')).toBe(
      'Edited since the list response',
    );
    expect(snapshot?.hash).toBe(hashBody('Edited since the list response'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
