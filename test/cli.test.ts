import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { fixtureEnv, repo, setup } from './helpers.js';

describe('CLI', () => {
  it('dry-runs dispatch against issues.opened.json with planned writes and zero mutations', async () => {
    const { appClient, userClient, state } = setup();
    const before = structuredClone(state);
    const output: string[] = [];
    const factory = vi
      .fn()
      .mockReturnValueOnce(appClient)
      .mockReturnValueOnce(userClient);
    expect(
      await main(
        ['dispatch', '--dry-run'],
        fixtureEnv(),
        (line) => output.push(line),
        factory,
      ),
    ).toBe(0);
    expect(output).toHaveLength(3);
    expect(output[0]).toContain('[dry-run] assignCopilot');
    expect(output[1]).toContain('[dry-run] addLabels');
    expect(output[2]).toContain('[dry-run] createComment');
    expect(state.writes).toEqual([]);
    expect(structuredClone(state)).toEqual(before);
  });
  it('uses separate App and user tokens for real dispatch', async () => {
    const { appClient, userClient, state } = setup();
    const factory = vi.fn((token) =>
      token === 'app-test' ? appClient : userClient,
    );
    expect(
      await main(
        ['dispatch'],
        { ...fixtureEnv(), APP_TOKEN: 'app-test', USER_TOKEN: 'user-test' },
        () => {},
        factory,
      ),
    ).toBe(0);
    expect(factory.mock.calls.map(([token]) => token)).toEqual([
      'app-test',
      'user-test',
    ]);
    expect(state.writes.map((v) => v.identity)).toEqual(['user', 'app', 'app']);
  });
  it('automerge only constructs an App client, and reads configuration from the default branch', async () => {
    const { appClient } = setup('pull_request_target');
    const factory = vi.fn(() => appClient);
    const read = vi.spyOn(appClient, 'getFile');
    expect(
      await main(
        ['automerge'],
        { ...fixtureEnv('pull_request_target'), APP_TOKEN: 'app-test' },
        () => {},
        factory,
      ),
    ).toBe(0);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(repo, '.github/ai-factory.yml', 'main');
  });
  it('runs labels without webhook env; its dry-run reports status without changing labels', async () => {
    const { appClient, state } = setup();
    const logs: string[] = [];
    expect(
      await main(
        ['labels', '--repo', repo, '--dry-run'],
        {},
        (line) => logs.push(line),
        () => appClient,
      ),
    ).toBe(0);
    expect(state.writes).toHaveLength(0);
    expect(state.labels.size).toBe(0);
    expect(logs.some((line) => line.includes('created label ai:manual'))).toBe(
      true,
    );
  });
  it.each(
    [
      [],
      ['unknown'],
      ['dispatch', '--repo', repo],
      ['labels'],
      ['labels', '--repo', 'invalid'],
      ['dispatch', '--bad-flag'],
      ['dispatch', 'extra'],
    ].map((args) => ({ args })),
  )(
    'returns 1 with an annotation for invalid arguments $args',
    async ({ args }) => {
      const logs: string[] = [];
      const factory = vi.fn();
      expect(await main(args, {}, (line) => logs.push(line), factory)).toBe(1);
      expect(logs[0]).toMatch(/^::error::/);
      expect(factory).not.toHaveBeenCalled();
    },
  );
  it('requires credentials for writes and redacts credentials from errors', async () => {
    const { appClient } = setup();
    const logs: string[] = [];
    expect(
      await main(
        ['dispatch'],
        fixtureEnv(),
        (line) => logs.push(line),
        () => appClient,
      ),
    ).toBe(1);
    expect(logs.at(-1)).toContain('APP_TOKEN is required');
    expect(
      await main(
        ['dispatch'],
        { ...fixtureEnv(), APP_TOKEN: 'app-secret' },
        (line) => logs.push(line),
        () => appClient,
      ),
    ).toBe(1);
    expect(logs.at(-1)).toContain('USER_TOKEN');
    appClient.getRepo = () =>
      Promise.reject(new Error('failed with app-secret\n::warning::oops'));
    expect(
      await main(
        ['labels', '--repo', repo],
        { APP_TOKEN: 'app-secret' },
        (line) => logs.push(line),
        () => appClient,
      ),
    ).toBe(1);
    expect(logs.at(-1)).toContain('[REDACTED]%0A');
    expect(logs.join('\n')).not.toContain('app-secret');
  });
  it('reports API status without printing request data', async () => {
    const { appClient } = setup();
    const logs: string[] = [];
    appClient.getRepo = () =>
      Promise.reject(
        Object.assign(new Error('sensitive request payload'), {
          status: 403,
          request: { authorization: 'do-not-print' },
        }),
      );
    expect(
      await main(
        ['labels', '--repo', repo],
        { APP_TOKEN: 'token' },
        (line) => logs.push(line),
        () => appClient,
      ),
    ).toBe(1);
    expect(logs).toEqual(['::error::GitHub API request failed (status 403)']);
  });
});
