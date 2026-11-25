import { EventEmitter } from 'node:events';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCreateApp, saveKey } from '../scripts/create-github-app.js';

const mocks = vi.hoisted(() => ({ createServer: vi.fn(), spawn: vi.fn() }));
vi.mock('node:http', () => ({ createServer: mocks.createServer }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

const conversion = {
  id: 321,
  slug: 'example-app',
  html_url: 'https://github.com/apps/example-app',
  pem: 'PRIVATE-KEY-CONTENTS',
  client_secret: 'CLIENT-SECRET-CONTENTS',
  webhook_secret: 'WEBHOOK-SECRET-CONTENTS',
};
const argv = [
  '--owner',
  'roy2392',
  '--repos',
  'ai-factory,showcase',
  '--secrets-repo',
  'roy2392/showcase',
];
let home: string;
let handler: (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;
let server: EventEmitter & {
  listen: ReturnType<typeof vi.fn>;
  address: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
};
let subprocesses: {
  command: string;
  args: string[];
  stdin: string;
  options: Record<string, unknown>;
}[];
let ghExit: number;
let fetchMock: ReturnType<typeof vi.fn>;
const log = vi.fn<(message: string) => void>();

beforeEach(async () => {
  vi.clearAllMocks();
  home = await mkdtemp(join(tmpdir(), 'factory-app-test-'));
  ghExit = 0;
  subprocesses = [];
  server = Object.assign(new EventEmitter(), {
    listen: vi.fn((_port, _host, callback: () => void) => {
      queueMicrotask(callback);
    }),
    address: vi.fn(() => ({ port: 12345 })),
    close: vi.fn((callback: () => void) => callback()),
    closeAllConnections: vi.fn(),
  });
  mocks.createServer.mockImplementation((listener) => {
    handler = listener;
    return server;
  });
  mocks.spawn.mockImplementation(
    (command: string, args: string[], options: Record<string, unknown>) => {
      const record = { command, args, stdin: '', options };
      subprocesses.push(record);
      const child = Object.assign(new EventEmitter(), {
        stdin: new Writable({
          write(chunk, _encoding, callback) {
            record.stdin += String(chunk);
            callback();
          },
        }),
        kill: vi.fn(),
      });
      queueMicrotask(() => child.emit('close', command === 'gh' ? ghExit : 0));
      return child;
    },
  );
  fetchMock = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => conversion });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await rm(home, { recursive: true, force: true });
});

async function request(url: string, method = 'GET') {
  const response = { setHeader: vi.fn(), writeHead: vi.fn(), end: vi.fn() };
  await handler(
    { url, method } as IncomingMessage,
    response as unknown as ServerResponse,
  );
  return response;
}

async function start(extraArgs: string[] = []) {
  const result = runCreateApp([...argv, ...extraArgs], { homeDir: home, log });
  await Promise.resolve(); // mocked listen callback; no socket is opened
  const form = await request('/');
  const page = String(form.end.mock.calls[0]![0]);
  const state = page.match(/new\?state=([a-f0-9]+)"/)![1]!;
  return { result, state, form };
}

function expectNoSecretOutput(browserOutput = '') {
  const visible =
    JSON.stringify(log.mock.calls) +
    browserOutput +
    JSON.stringify(
      subprocesses.map(({ command, args }) => ({ command, args })),
    );
  for (const secret of [
    conversion.pem,
    conversion.client_secret,
    conversion.webhook_secret,
  ])
    expect(visible).not.toContain(secret);
}

describe('mocked manifest flow (no browser, network, or gh execution)', () => {
  it('binds loopback on a random port, converts once, stores via stdin, and links installation', async () => {
    const { result, state, form } = await start(['--name', 'custom-app']);
    expect(state).toMatch(/^[a-f0-9]{64}$/);
    expect(server.listen).toHaveBeenCalledWith(
      0,
      '127.0.0.1',
      expect.any(Function),
    );
    expect(form.end.mock.calls[0]![0]).toContain('custom-app');
    expect(form.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(subprocesses[0]!.command).toBe(
      process.platform === 'darwin' ? 'open' : 'xdg-open',
    );
    expect(subprocesses[0]!.args).toEqual(['http://127.0.0.1:12345']);
    const response = await request(
      `/callback?code=one-use-code&state=${state}`,
    );
    expect(await result).toBe(0);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://api.github.com/app-manifests/one-use-code/conversions',
      {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json' },
        redirect: 'error',
        signal: expect.any(AbortSignal),
      },
    );
    const gh = subprocesses.filter((process) => process.command === 'gh');
    expect(gh.map((process) => [process.args, process.stdin])).toEqual([
      [['secret', 'set', 'FACTORY_APP_ID', '-R', 'roy2392/showcase'], '321'],
      [
        ['secret', 'set', 'FACTORY_APP_PRIVATE_KEY', '-R', 'roy2392/showcase'],
        conversion.pem,
      ],
    ]);
    for (const process of gh)
      expect(process.options).toMatchObject({
        shell: false,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    const path = join(home, '.config/ai-factory/example-app.pem');
    expect(await readFile(path, 'utf8')).toBe(conversion.pem);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, '.config/ai-factory'))).mode & 0o777).toBe(
      0o700,
    );
    expect(log.mock.calls.flat().join('\n')).toContain(
      'Install it on: ai-factory,showcase',
    );
    expect(response.end.mock.calls[0]![0]).toContain(
      'https://github.com/apps/example-app/installations/new',
    );
    expectNoSecretOutput(String(response.end.mock.calls[0]![0]));
    expect(server.close).toHaveBeenCalledOnce();
    await request(`/callback?code=one-use-code&state=${state}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched state without exchanging code and keeps waiting for a valid callback', async () => {
    const { result, state } = await start();
    const bad = await request('/callback?code=secret-code&state=wrong');
    expect(bad.writeHead).toHaveBeenCalledWith(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(server.close).not.toHaveBeenCalled();
    await request(`/callback?code=ok&state=${state}`);
    expect(await result).toBe(0);
  });
  it('gives safe manual stdin commands on gh failure while retaining the key and installation link', async () => {
    ghExit = 1;
    const { result, state } = await start();
    const response = await request(`/callback?code=ok&state=${state}`);
    expect(await result).toBe(0);
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain(
      "printf '%s' '321' | gh secret set FACTORY_APP_ID -R 'roy2392/showcase'",
    );
    expect(output).toContain(
      `gh secret set FACTORY_APP_PRIVATE_KEY -R 'roy2392/showcase' < '${join(home, '.config/ai-factory/example-app.pem')}'`,
    );
    expect(response.end.mock.calls[0]![0]).toContain('needs attention');
    expectNoSecretOutput(String(response.end.mock.calls[0]![0]));
  });
  it('never logs conversion error bodies, rejected values, or exception details', async () => {
    fetchMock.mockRejectedValue(new Error(JSON.stringify(conversion)));
    const { result, state } = await start();
    const response = await request(`/callback?code=ok&state=${state}`);
    expect(await result).toBe(1);
    expect(response.writeHead).toHaveBeenCalledWith(500);
    expectNoSecretOutput(String(response.end.mock.calls[0]![0]));
    expect(
      subprocesses.filter((process) => process.command === 'gh'),
    ).toHaveLength(0);
  });
  it('suppresses subprocess exception details and supplies the manual fallback', async () => {
    const { result, state } = await start();
    mocks.spawn.mockImplementation(() => {
      throw new Error(conversion.pem);
    });
    const response = await request(`/callback?code=ok&state=${state}`);
    expect(await result).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain(
      'gh failed to store FACTORY_APP_PRIVATE_KEY',
    );
    expectNoSecretOutput(String(response.end.mock.calls[0]![0]));
  });
  it.each(['http-error', 'malformed-conversion'])(
    'keeps %s responses out of logs and never stores secrets',
    async (mode) => {
      fetchMock.mockResolvedValue({
        ok: mode !== 'http-error',
        json: async () => ({ ...conversion, id: conversion.pem }),
      });
      const { result, state } = await start();
      const response = await request(`/callback?code=ok&state=${state}`);
      expect(await result).toBe(1);
      expect(response.writeHead).toHaveBeenCalledWith(500);
      expectNoSecretOutput(String(response.end.mock.calls[0]![0]));
      expect(
        subprocesses.filter((process) => process.command === 'gh'),
      ).toHaveLength(0);
    },
  );
  it('allows only one exchange while a callback is in flight and aborts it on timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let complete!: (response: unknown) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const { result, state } = await start();
    const first = request(`/callback?code=ok&state=${state}`);
    const duplicate = await request(`/callback?code=ok&state=${state}`);
    expect(duplicate.writeHead).toHaveBeenCalledWith(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(await result).toBe(1);
    expect(fetchMock.mock.calls[0]![1].signal.aborted).toBe(true);
    // Even a transport ignoring abort must not save late credentials.
    complete({ ok: true, json: async () => conversion });
    await first;
    expect(
      subprocesses.filter((process) => process.command === 'gh'),
    ).toHaveLength(0);
    await expect(
      stat(join(home, '.config/ai-factory/example-app.pem')),
    ).rejects.toThrow();
  });
  it('times out after 15 minutes, aborts pending work, and exits 1', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { result } = await start();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(await result).toBe(1);
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect((subprocesses[0]!.options.signal as AbortSignal).aborted).toBe(true);
    expect(log).toHaveBeenCalledWith('App setup timed out after 15 minutes.');
  });
  it('rejects invalid flags before starting any IO', async () => {
    expect(await runCreateApp(['--owner', '../unsafe'], { log })).toBe(1);
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });
});

describe('key file safety', () => {
  it('refuses overwrites, but force replaces the file and tightens existing permissions', async () => {
    const path = await saveKey(home, 'test-app', 'old', false);
    await expect(saveKey(home, 'test-app', 'new', false)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('old');
    await chmod(path, 0o644);
    await chmod(join(home, '.config/ai-factory'), 0o755);
    await saveKey(home, 'test-app', 'new', true);
    expect(await readFile(path, 'utf8')).toBe('new');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, '.config/ai-factory'))).mode & 0o777).toBe(
      0o700,
    );
  });
  it('rejects traversal slugs and symlink key files even with force', async () => {
    await expect(saveKey(home, '../escape', 'key', true)).rejects.toThrow();
    const directory = join(home, '.config/ai-factory');
    await mkdir(directory, { recursive: true });
    const outside = join(home, 'outside');
    await writeFile(outside, 'untouched');
    await symlink(outside, join(directory, 'test-app.pem'));
    await expect(saveKey(home, 'test-app', 'key', true)).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('untouched');
  });
  it('refuses a symlink key directory', async () => {
    await mkdir(join(home, '.config'));
    const outside = join(home, 'outside');
    await mkdir(outside);
    await symlink(outside, join(home, '.config/ai-factory'));
    await expect(saveKey(home, 'test-app', 'key', true)).rejects.toThrow();
    await expect(stat(join(outside, 'test-app.pem'))).rejects.toThrow();
  });
});
