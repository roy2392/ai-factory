import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { configSchema, DEFAULT_CONFIG, loadConfig } from '../src/config.js';
import { repo, setup } from './helpers.js';

describe('configuration', () => {
  it('uses all defaults for a missing file and the actual repository default branch', async () => {
    const { appClient } = setup();
    expect(
      await loadConfig(
        appClient,
        { full_name: repo, default_branch: 'trunk' },
        'trunk',
      ),
    ).toEqual({ ...DEFAULT_CONFIG, base_branch: 'trunk' });
  });
  it('merges partial nested values and honors an explicit base branch at the requested ref', async () => {
    const { appClient, state } = setup();
    state.files.set(
      `${repo}:trusted:.github/ai-factory.yml`,
      'base_branch: stable\nlabels:\n  needs_plan: design\nrequirements:\n  max_open: 5\nagents:\n  implementer: ""',
    );
    const config = await loadConfig(
      appClient,
      { full_name: repo, default_branch: 'main' },
      'trusted',
    );
    expect(config).toEqual({
      ...DEFAULT_CONFIG,
      base_branch: 'stable',
      labels: { ...DEFAULT_CONFIG.labels, needs_plan: 'design' },
      requirements: { ...DEFAULT_CONFIG.requirements, max_open: 5 },
      agents: { ...DEFAULT_CONFIG.agents, implementer: '' },
    });
  });
  it.each([
    ['typo: true', 'typo'],
    ['requirements:\n  max_opne: 2', 'requirements.max_opne'],
    ['agents:\n  typo: x', 'agents.typo'],
    ['labels:\n  typo: x', 'labels.typo'],
  ])('lists unknown key paths for %s', async (content, path) => {
    const { appClient, state } = setup();
    state.files.set(`${repo}:main:.github/ai-factory.yml`, content!);
    await expect(
      loadConfig(
        appClient,
        { full_name: repo, default_branch: 'main' },
        'main',
      ),
    ).rejects.toThrow(path);
  });
  it.each([
    ['max_fix_attempts', 0, 10],
    ['stale_hours', 1, 168],
    ['requirements.max_open', 1, 20],
    ['requirements.max_tasks_per_run', 1, 30],
  ] as const)(
    'enforces both boundaries and integer type for %s',
    (path, min, max) => {
      const input = (value: unknown) =>
        path.startsWith('requirements.')
          ? { requirements: { [path.split('.')[1]!]: value } }
          : { [path]: value };
      for (const value of [min, max])
        expect(configSchema.safeParse(input(value)).success).toBe(true);
      for (const value of [min - 1, max + 1, min + 0.5, String(min)])
        expect(configSchema.safeParse(input(value)).success).toBe(false);
    },
  );
  it('validates version, association, plan gate and merge method enums', () => {
    for (const version of [0, 2, '1'])
      expect(configSchema.safeParse({ version }).success).toBe(false);
    for (const association of [
      'OWNER',
      'MEMBER',
      'COLLABORATOR',
      'CONTRIBUTOR',
    ])
      expect(
        configSchema.parse({ allowed_associations: [association] })
          .allowed_associations,
      ).toEqual([association]);
    expect(
      configSchema.safeParse({ allowed_associations: ['NONE'] }).success,
    ).toBe(false);
    for (const plan_gate of ['label', 'always', 'never'])
      expect(configSchema.safeParse({ plan_gate }).success).toBe(true);
    expect(configSchema.safeParse({ plan_gate: 'sometimes' }).success).toBe(
      false,
    );
    for (const merge_method of ['merge', 'squash', 'rebase'])
      expect(configSchema.safeParse({ merge_method }).success).toBe(true);
    expect(
      configSchema.safeParse({ merge_method: 'fast-forward' }).success,
    ).toBe(false);
  });
  it('rejects malformed YAML and wrong root types without leaking values', async () => {
    const { appClient, state } = setup();
    for (const content of [
      'labels: [',
      'secret-value',
      stringify(['bad']),
      'version: 1\nversion: 1',
    ]) {
      state.files.set(`${repo}:main:.github/ai-factory.yml`, content);
      await expect(
        loadConfig(
          appClient,
          { full_name: repo, default_branch: 'main' },
          'main',
        ),
      ).rejects.toThrow('Invalid');
    }
  });
  it('accepts empty files and does not swallow network or authorization errors', async () => {
    const { appClient, state } = setup();
    state.files.set(`${repo}:main:.github/ai-factory.yml`, '');
    expect(
      await loadConfig(
        appClient,
        { full_name: repo, default_branch: 'main' },
        'main',
      ),
    ).toEqual(DEFAULT_CONFIG);
    appClient.getFile = () => Promise.reject(new Error('forbidden'));
    await expect(
      loadConfig(
        appClient,
        { full_name: repo, default_branch: 'main' },
        'main',
      ),
    ).rejects.toThrow('forbidden');
  });
});
