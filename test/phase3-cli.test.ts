import { expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { fixtureEnv } from './helpers.js';
import { selfHealSetup, watchdogSetup } from './phase3-helpers.js';

it('routes self-heal with App reads/labels and a separate user-comment client', async () => {
  const { appClient, userClient, state } = selfHealSetup();
  const factory = vi.fn((token) =>
    token === 'app-token' ? appClient : userClient,
  );
  expect(
    await main(
      ['self-heal'],
      {
        ...fixtureEnv('workflow_run'),
        APP_TOKEN: 'app-token',
        USER_TOKEN: 'user-token',
      },
      () => {},
      factory,
    ),
  ).toBe(0);
  expect(factory.mock.calls.map(([token]) => token)).toEqual([
    'app-token',
    'user-token',
  ]);
  expect(
    state.writes
      .filter((w) => w.method === 'createComment')
      .map((w) => w.identity),
  ).toEqual(['user']);
});
it('dry-runs self-heal without mutating counters or comments and redacts downloaded log secrets', async () => {
  const { appClient, state } = selfHealSetup();
  state.jobLogs.set('acme/widget#1', 'ghp_private-log-secret');
  const messages: string[] = [];
  expect(
    await main(
      ['self-heal', '--dry-run'],
      fixtureEnv('workflow_run'),
      (line) => messages.push(line),
      () => appClient,
    ),
  ).toBe(0);
  expect(state.writes).toHaveLength(0);
  expect(messages.join('\n')).not.toContain('ghp_private-log-secret');
  expect(messages.join('\n')).toContain('[redacted]');
});
it('constructs only an App client for manual/scheduled watchdog', async () => {
  const { appClient } = watchdogSetup();
  const factory = vi.fn(() => appClient);
  expect(
    await main(
      ['watchdog'],
      { ...fixtureEnv('workflow_dispatch'), APP_TOKEN: 'app-token' },
      () => {},
      factory,
    ),
  ).toBe(0);
  expect(factory).toHaveBeenCalledExactlyOnceWith('app-token', undefined);
});
