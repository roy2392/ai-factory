import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildCliArgs,
  COPILOT_CLI_VERSION,
  copilotEnvironment,
} from '../src/copilot-cli.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
describe('Copilot CLI invocation', () => {
  it.each(['plan', 'ask'] as const)(
    'builds %s arguments from the supplied 1.0.112 reference',
    (mode) => {
      const dir = mkdtempSync(join(tmpdir(), 'factory-cli-'));
      dirs.push(dir);
      const promptFile = join(dir, 'prompt.md');
      const prompt = 'Question with `backticks`, $(commands), and\nnewlines.';
      writeFileSync(promptFile, prompt);
      const args = buildCliArgs({ promptFile, mode });
      expect(args.slice(0, 2)).toEqual(['-p', prompt]);
      for (const value of [
        '--no-ask-user',
        '--no-auto-update',
        '--allow-tool',
        'write',
        'shell(git push)',
        'shell(gh:*)',
        'shell(curl:*)',
        'shell(wget:*)',
        '--disable-builtin-mcps',
      ])
        expect(args).toContain(value);
      expect(args).not.toContain('shell(git:*)');
      expect(args).not.toContain('--allow-all-tools');
      expect(args).not.toContain('--trust-folder');
      const help = readFileSync(
        `docs/reference/copilot-cli-${COPILOT_CLI_VERSION}-help.txt`,
        'utf8',
      );
      for (const flag of args.filter((arg) => arg.startsWith('--')))
        expect(help).toContain(flag);
      expect(COPILOT_CLI_VERSION).toBe('1.0.112');
    },
  );
  it('does not pass Actions runtime credentials or unrelated secrets to the model subprocess', () => {
    expect(
      copilotEnvironment({
        COPILOT_GITHUB_TOKEN: 'cli-only',
        PATH: '/bin',
        ACTIONS_RUNTIME_TOKEN: 'runtime',
        CUSTOM_SECRET: 'secret',
        GITHUB_OUTPUT: '/tmp/out',
      }),
    ).toEqual({ COPILOT_GITHUB_TOKEN: 'cli-only', PATH: '/bin' });
  });
  it.each(['APP_TOKEN', 'USER_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'])(
    'rejects an inherited %s',
    (key) => {
      expect(() =>
        copilotEnvironment({ COPILOT_GITHUB_TOKEN: 'cli', [key]: 'secret' }),
      ).toThrow(key);
    },
  );
});
