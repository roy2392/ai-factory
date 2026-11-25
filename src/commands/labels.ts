import { LABELS } from '../labels.js';
import type { Dependencies } from './types.js';

export async function run({
  event,
  appClient,
  log,
}: Dependencies): Promise<void> {
  const results = await appClient.ensureLabels(event.repo, LABELS);
  log('Label\tStatus');
  for (const { name, status } of results) log(`${name}\t${status}`);
}
