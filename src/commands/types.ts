import type { FactoryConfig } from '../config.js';
import type { FactoryEvent } from '../context.js';
import type { GitHubClient } from '../github/client.js';

export interface Dependencies {
  event: FactoryEvent;
  appClient: GitHubClient;
  userClient: GitHubClient;
  config: FactoryConfig;
  log: (message: string) => void;
}

export function notice(log: Dependencies['log'], reason: string): void {
  log(
    `::notice::${reason.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`,
  );
}
