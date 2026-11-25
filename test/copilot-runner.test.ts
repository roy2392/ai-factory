import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.each(['ask', 'analyze', 'review'])(
  'runs the isolated %s adapter with a stub executable, never a shell-expanded prompt',
  (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-runner-'));
    try {
      mkdirSync(join(dir, 'out'));
      const prompt = 'Do not execute $(touch injected-file); `echo malicious`.';
      writeFileSync(join(dir, 'out/mode.txt'), mode);
      writeFileSync(join(dir, 'out/prompt.md'), prompt);
      const binary = join(dir, 'copilot');
      writeFileSync(
        binary,
        '#!/usr/bin/env node\n' +
          `require('node:fs').writeFileSync('out/captured.json', JSON.stringify({args:process.argv.slice(2),keys:Object.keys(process.env)}));\nrequire('node:fs').writeFileSync('out/answer.md', 'Stub answer.');\n`,
      );
      chmodSync(binary, 0o755);
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          fileURLToPath(new URL('../src/run-copilot.ts', import.meta.url)),
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          env: {
            PATH: `${dir}${delimiter}${process.env.PATH}`,
            COPILOT_GITHUB_TOKEN: 'fixture-token',
            ACTIONS_RUNTIME_TOKEN: 'must-not-propagate',
            CUSTOM_SECRET: 'must-not-propagate',
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      const captured = JSON.parse(
        readFileSync(join(dir, 'out/captured.json'), 'utf8'),
      ) as { args: string[]; keys: string[] };
      expect(captured.args.slice(0, 2)).toEqual(['-p', prompt]);
      expect(captured.keys).not.toContain('ACTIONS_RUNTIME_TOKEN');
      expect(captured.keys).not.toContain('CUSTOM_SECRET');
      if (mode !== 'ask')
        expect(captured.args).toContain(
          `write(${join(realpathSync(dir), 'out/issues.json')})`,
        );
      expect(existsSync(join(dir, 'injected-file'))).toBe(false);
      expect(readFileSync(join(dir, 'out/answer.md'), 'utf8')).toBe(
        'Stub answer.',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
