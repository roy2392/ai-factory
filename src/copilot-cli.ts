import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const COPILOT_CLI_VERSION = '1.0.112';
export type ThinkMode = 'ask' | 'plan' | 'analyze' | 'review';
export function parseMode(value: string | undefined): ThinkMode {
  if (
    value !== 'ask' &&
    value !== 'plan' &&
    value !== 'analyze' &&
    value !== 'review'
  )
    throw new Error('Mode must be ask, plan, analyze or review');
  return value;
}

// Flag and rule syntax comes from docs/reference/copilot-cli-1.0.112-*.txt.
export function buildCliArgs({
  promptFile,
  mode,
}: {
  promptFile: string;
  mode: ThinkMode;
}): string[] {
  parseMode(mode);
  const prompt = readFileSync(promptFile, 'utf8');
  if (!prompt.trim()) throw new Error('Prompt file is empty');
  return [
    '-p',
    prompt,
    '--no-ask-user',
    '--no-auto-update',
    '--no-bash-env',
    '--no-custom-instructions',
    '--disable-builtin-mcps',
    '--no-experimental',
    '--secret-env-vars',
    'COPILOT_GITHUB_TOKEN',
    '--allow-tool',
    'read',
    '--allow-tool',
    mode === 'analyze' || mode === 'review'
      ? `write(${resolve(dirname(promptFile), 'issues.json')})`
      : 'write',
    // Permission rules cannot constrain git options (-c aliases, pagers,
    // external diff/textconv) or find -exec. Built-in read tools cover discovery.
    // Deny all shell execution, including implicitly classified read-only commands.
    ...[
      'shell',
      'shell(git push)',
      'shell(gh:*)',
      'shell(curl:*)',
      'shell(wget:*)',
      'url',
      'memory',
    ].flatMap((rule) => ['--deny-tool', rule]),
  ];
}

/** Pass only the CLI credential and ordinary runtime settings to the subprocess. */
export function copilotEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of ['APP_TOKEN', 'USER_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'])
    if (env[name]) throw new Error(`Copilot runner must not receive ${name}`);
  if (!env.COPILOT_GITHUB_TOKEN)
    throw new Error('COPILOT_GITHUB_TOKEN is required');
  const allowed = new Set([
    'PATH',
    'HOME',
    'USER',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SYSTEMROOT',
    'SystemRoot',
    'CI',
    'COPILOT_GITHUB_TOKEN',
  ]);
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => allowed.has(key)),
  );
}
