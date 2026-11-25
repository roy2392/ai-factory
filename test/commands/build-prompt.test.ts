import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { run } from '../../src/commands/build-prompt.js';
import { repo } from '../helpers.js';
import { commandSetup } from '../phase2-helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
it('builds a plan from read APIs at the default branch and removes stale model output', async () => {
  const { deps, state, appClient } = commandSetup('/ai plan');
  state.files.set(`${repo}:main:AGENTS.md`, 'Use existing tests.');
  const read = vi.spyOn(appClient, 'getFile');
  const outputDir = mkdtempSync(join(tmpdir(), 'factory-prompt-'));
  dirs.push(outputDir);
  writeFileSync(join(outputDir, 'plan.md'), 'stale plan');
  await run(deps, { mode: 'plan', outputDir });
  expect(read).toHaveBeenCalledWith(repo, 'AGENTS.md', 'main');
  expect(readFileSync(join(outputDir, 'prompt.md'), 'utf8')).toContain(
    'Use existing tests.',
  );
  expect(readFileSync(join(outputDir, 'mode.txt'), 'utf8')).toBe('plan');
  expect(existsSync(join(outputDir, 'plan.md'))).toBe(false);
  expect(state.writes).toHaveLength(0);
});
it('uses the triggering question and keeps dry-run free of file writes', async () => {
  const { deps, state } = commandSetup('/ai ask Where is routing?');
  const outputDir = mkdtempSync(join(tmpdir(), 'factory-prompt-'));
  dirs.push(outputDir);
  await run(deps, { mode: 'ask', outputDir, dryRun: true });
  expect(existsSync(join(outputDir, 'prompt.md'))).toBe(false);
  await run(deps, { mode: 'ask', outputDir });
  expect(readFileSync(join(outputDir, 'prompt.md'), 'utf8')).toContain(
    'Where is routing?',
  );
  expect(state.writes).toHaveLength(0);
});
