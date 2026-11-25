import { stripVTControlCharacters } from 'node:util';
import { capText } from './text.js';

export function cleanLog(log: string): string[] {
  let privateBlock = false;
  return stripVTControlCharacters(log)
    .replace(/\r\n?/g, '\n')
    .replace(/\n$/, '')
    .split('\n')
    .map((raw) => {
      const line = raw.replace(
        /^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\]?\s*/,
        '',
      );
      if (/-----BEGIN/i.test(line)) privateBlock = true;
      const redact = privateBlock || /ghp_|github_pat_|ghs_/i.test(line);
      if (/-----END/i.test(line)) privateBlock = false;
      return redact ? '[redacted]' : line;
    });
}

// Logs are untrusted PR-controlled data, never runnable text or factory state.
export function logText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`/g, '\\u0060');
}
export function safeName(text: string): string {
  return capText(
    logText(cleanLog(text).join(' ')).replace(/[@[\]*_]/g, ''),
    200,
    600,
  );
}
export function logTails(
  jobs: readonly { name: string; log: string }[],
): string {
  const parts = jobs
    .slice(0, 3)
    .map(
      ({ name, log }) =>
        `Job: ${safeName(name)}\n${logText(cleanLog(log).slice(-150).join('\n'))}`,
    );
  // A fair per-job budget keeps all three failed jobs represented.
  const separator = '\n\n';
  const budget = Math.floor(
    (20000 - Math.max(0, parts.length - 1) * separator.length) /
      Math.max(1, parts.length),
  );
  return parts.map((part) => capText(part, budget, budget)).join(separator);
}
