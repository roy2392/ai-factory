import { describe, expect, it } from 'vitest';
import { parseAiCommand } from '../src/commands/parse.js';

describe('/ai command parser', () => {
  it.each(['ask', 'do', 'plan', 'go', 'stop'] as const)(
    'parses %s case-insensitively with multiline arguments',
    (cmd) => {
      expect(
        parseAiCommand(
          `\n\n /AI ${cmd.toUpperCase()} first line\r\nsecond line \n`,
        ),
      ).toEqual({ cmd, arg: 'first line\nsecond line' });
    },
  );
  it.each(['/ai', '/AI unknown details', '/ai ask', '/ai do', '/ai help'])(
    'returns help for %s',
    (body) => {
      expect(parseAiCommand(body)?.cmd).toBe('help');
    },
  );
  it.each([
    '',
    '\n \n',
    '/aiX ask hello',
    'intro\n/ai ask question',
    'say /ai plan',
    '```\n/ai go\n```',
    '/ai\task question',
  ])('does not match %j', (body) => {
    expect(parseAiCommand(body)).toBeNull();
  });
  it('takes following lines as the argument even if the first line has no argument', () => {
    expect(parseAiCommand('/ai ask\n Where is the router? ')).toEqual({
      cmd: 'ask',
      arg: 'Where is the router?',
    });
  });
  it('caps arguments at 4,000 characters', () => {
    expect(parseAiCommand(`/ai do ${'a'.repeat(5000)}`)?.arg).toHaveLength(
      4000,
    );
  });
});
