import type { Label } from './github/client.js';

export const LABELS: readonly Label[] = [
  {
    name: 'ai:manual',
    color: 'ededed',
    description: 'Human-owned; automatic dispatch disabled',
  },
  {
    name: 'ai:needs-plan',
    color: 'd4c5f9',
    description: 'A plan is required before implementation',
  },
  {
    name: 'ai:plan-ready',
    color: 'c5def5',
    description: 'Plan is ready for approval',
  },
  {
    name: 'ai:needs-info',
    color: 'fbca04',
    description: 'More information is required',
  },
  {
    name: 'ai:in-progress',
    color: '1d76db',
    description: 'Copilot implementation in progress',
  },
  {
    name: 'ai:awaiting-review',
    color: '0e8a16',
    description: 'Ready for human review',
  },
  {
    name: 'ai:stale',
    color: 'fbca04',
    description: 'No recent implementation activity',
  },
  {
    name: 'ai:human-needed',
    color: 'b60205',
    description: 'Human intervention required',
  },
  ...Array.from({ length: 10 }, (_, i) => ({
    name: `ai:fix-${i + 1}`,
    color: 'f9d0c4',
    description: `CI repair attempt ${i + 1}`,
  })),
  {
    name: 'requirements',
    color: '5319e7',
    description: 'Parent requirements issue',
  },
];

export function fixAttemptOf(labels: string[]): number {
  return Math.max(
    0,
    ...labels.map((label) => {
      const match = /^ai:fix-([1-9]|10)$/.exec(label);
      return match ? Number(match[1]) : 0;
    }),
  );
}
