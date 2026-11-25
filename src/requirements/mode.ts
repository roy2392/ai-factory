import type { FactoryConfig } from '../config.js';
import type { Task } from './tasks.js';
import type { RequirementsState } from './state.js';
import { selectReleasable } from './release.js';
export type RequirementsMode = 'analyze' | 'release' | 'review' | 'idle';
export const MAX_REVIEW_ROUNDS = 3;
export function decideMode({
  state,
  bodyHash,
  tasks,
  config,
}: {
  state: RequirementsState | null;
  bodyHash: string;
  tasks: Task[];
  config: FactoryConfig;
}): RequirementsMode {
  if (!config.requirements.enabled) return 'idle';
  if (!state || state.hash !== bodyHash) return 'analyze';
  if (selectReleasable(tasks, config.requirements.max_open).length)
    return 'release';
  if (
    tasks.every((t) => t.state === 'closed') &&
    state.reviewed_hash !== bodyHash &&
    state.review_rounds < MAX_REVIEW_ROUNDS
  )
    return 'review';
  return 'idle';
}
