import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import {
  requirementsPrompt,
  reviewPrompt,
} from '../../src/requirements/prompts.js';
import { requirementsSetup } from './helpers.js';
it('stages exactly the skill inputs, removes stale model output, and refuses checkout symlink directories', () => {
  const dir = mkdtempSync(join(tmpdir(), 'factory-stage-'));
  try {
    const input = join(dir, 'input'),
      target = join(dir, 'target'),
      skill = join(dir, 'SKILL.md');
    mkdirSync(input);
    mkdirSync(target);
    mkdirSync(join(target, 'out'));
    for (const name of [
      'requirements.md',
      'existing-tasks.json',
      'mode.txt',
      'prompt.md',
    ])
      writeFileSync(join(input, name), name);
    writeFileSync(skill, 'trusted skill');
    writeFileSync(join(target, 'out/issues.json'), 'stale repository artifact');
    const run = () =>
      spawnSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          fileURLToPath(
            new URL('../../src/stage-requirements.ts', import.meta.url),
          ),
          input,
          skill,
        ],
        { cwd: target, encoding: 'utf8' },
      );
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(target, 'out/issues.json'))).toBe(false);
    expect(
      readFileSync(
        join(target, '.github/skills/requirements-breakdown/SKILL.md'),
        'utf8',
      ),
    ).toBe('trusted skill');
    expect(readFileSync(join(target, 'out/requirements.md'), 'utf8')).toBe(
      'requirements.md',
    );
    rmSync(join(target, '.github'), { recursive: true, force: true });
    symlinkSync(input, join(target, '.github'));
    expect(run().status).not.toBe(0);
    expect(readFileSync(join(input, 'requirements.md'), 'utf8')).toBe(
      'requirements.md',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('prompts preserve read/write-only framing and bound argument size for large review context', () => {
  const { parent } = requirementsSetup();
  const tasks = [
    { id: 'a', title: 'Untrusted `$(command)`', status: 'closed' as const },
  ];
  expect(requirementsPrompt(parent, tasks)).toContain(
    'out/existing-tasks.json',
  );
  const prompt = reviewPrompt(parent, tasks, [
    { number: 13, body: '😃'.repeat(100000) },
  ]);
  expect(Buffer.byteLength(prompt)).toBeLessThan(120000);
  expect(prompt).toContain('truncated');
  expect(prompt).toContain('\\u0060');
  expect(prompt).toContain('Write []');
  expect(prompt).toMatch(/write only out\/issues.json\.$/);
});
