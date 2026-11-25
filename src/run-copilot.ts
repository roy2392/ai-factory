import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildCliArgs, copilotEnvironment, parseMode } from './copilot-cli.js';

// A separate, credential-isolated runner; never interpolate the prompt into a shell.
try {
  const mode = parseMode(readFileSync('out/mode.txt', 'utf8').trim());
  const result = spawnSync(
    'copilot',
    buildCliArgs({ promptFile: 'out/prompt.md', mode }),
    {
      shell: false,
      env: copilotEnvironment(process.env),
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `Copilot CLI failed (${result.status ?? 'could not start'}); no model output is executed or logged`,
    );
} catch (error) {
  console.error(
    `::error::${error instanceof Error ? error.message : 'Copilot CLI failed'}`,
  );
  process.exitCode = 1;
}
