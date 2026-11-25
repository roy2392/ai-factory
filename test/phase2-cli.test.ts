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
import { main } from '../src/cli.js';
import { fixtureEnv, setup } from './helpers.js';

const dirs: string[] = [];
function temporary() {
  const dir = mkdtempSync(join(tmpdir(), 'factory-main-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it('writes fixed routing outputs to GITHUB_OUTPUT without logging comment text', async () => {
  const { appClient, userClient } = setup('issue_comment');
  const logs: string[] = [];
  const path = join(temporary(), 'outputs');
  const factory = vi.fn((token) => (token === 'app' ? appClient : userClient));
  expect(
    await main(
      ['ai-command'],
      {
        ...fixtureEnv('issue_comment'),
        APP_TOKEN: 'app',
        USER_TOKEN: 'user',
        GITHUB_OUTPUT: path,
      },
      (line) => logs.push(line),
      factory,
    ),
  ).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(
    'mode=ask\nissue=12\ncomment_id=42\n',
  );
  expect(logs).toEqual([]);
});
it('uses only the scoped GITHUB_TOKEN to build a prompt', async () => {
  const { appClient, state } = setup('issue_comment');
  const outputDir = temporary();
  const factory = vi.fn(() => appClient);
  expect(
    await main(
      ['build-prompt', '--mode', 'ask', '--output-dir', outputDir],
      { ...fixtureEnv('issue_comment'), GITHUB_TOKEN: 'read-token' },
      () => {},
      factory,
    ),
  ).toBe(0);
  expect(factory).toHaveBeenCalledExactlyOnceWith('read-token', undefined);
  expect(readFileSync(join(outputDir, 'prompt.md'), 'utf8')).toContain(
    'where is the router?',
  );
  expect(state.writes).toHaveLength(0);
});
it('publishes using only App Issues permissions and propagates missing-output exit 1', async () => {
  const { appClient } = setup('issue_comment');
  const readRepo = vi
    .spyOn(appClient, 'getRepo')
    .mockRejectedValue(new Error('No contents permission'));
  const readFile = vi
    .spyOn(appClient, 'getFile')
    .mockRejectedValue(new Error('No contents permission'));
  const outputDir = temporary();
  const env = { ...fixtureEnv('issue_comment'), APP_TOKEN: 'app-token' };
  expect(
    await main(
      ['post-answer', '--output-dir', outputDir],
      env,
      () => {},
      () => appClient,
    ),
  ).toBe(1);
  writeFileSync(join(outputDir, 'answer.md'), 'src/router.ts:1');
  expect(
    await main(
      ['post-answer', '--output-dir', outputDir],
      env,
      () => {},
      () => appClient,
    ),
  ).toBe(0);
  expect(readRepo).not.toHaveBeenCalled();
  expect(readFile).not.toHaveBeenCalled();
});
it('suppresses Actions output-file mutations during dry-run', async () => {
  const { appClient } = setup('issue_comment');
  const path = join(temporary(), 'outputs');
  expect(
    await main(
      ['ai-command', '--dry-run'],
      { ...fixtureEnv('issue_comment'), GITHUB_OUTPUT: path },
      () => {},
      () => appClient,
    ),
  ).toBe(0);
  expect(existsSync(path)).toBe(false);
});
