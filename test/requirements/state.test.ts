import { expect, it } from 'vitest';
import {
  hashBody,
  parseState,
  renderState,
} from '../../src/requirements/state.js';
import { task } from './helpers.js';
it('normalizes CRLF, trailing whitespace per line and boundary blank lines only', () => {
  expect(hashBody('\r\nhello  \r\nworld\t\r\n\r\n')).toBe(
    hashBody('hello\nworld'),
  );
  expect(hashBody(' hello')).not.toBe(hashBody('hello'));
  expect(hashBody('a\n\nb')).not.toBe(hashBody('a\nb'));
  expect(hashBody(null)).toBe(hashBody(''));
});
it('round trips a state and renders the table with issue numbers instead of database ids', () => {
  const state = {
    version: 1 as const,
    hash: hashBody('a'),
    reviewed_hash: '',
    review_rounds: 2,
    last_run: 'https://github.com/run/1',
  };
  const body = renderState(state, [
    task('a', 13, { state: 'closed' }),
    task('b', 14, { assignedToCopilot: true, blockedBy: [1013] }),
    task('c', 15),
  ]);
  expect(parseState([{ id: 1, body }])).toEqual(state);
  expect(body).toContain('| Task | Issue | Status | Blocked by |');
  expect(body).toContain('| b | #14 | in-progress | #13 |');
  expect(body).toContain('| c | #15 | open |');
  expect(body).toMatch(/^\*\*Requirements progress/);
  expect(body).toMatch(/ -->$/);
});
it('ignores malformed state and bounds a large table without losing the marker', () => {
  expect(
    parseState([{ id: 1, body: '<!-- ai-factory:req-state {} -->' }]),
  ).toBeNull();
  const state = {
    version: 1 as const,
    hash: hashBody('a'),
    reviewed_hash: '',
    review_rounds: 0,
    last_run: '',
  };
  const body = renderState(
    state,
    Array.from({ length: 5000 }, (_, n) => task(`task-${n}`, n)),
  );
  expect(Buffer.byteLength(body)).toBeLessThan(60000);
  expect(parseState([{ id: 1, body }])).toEqual(state);
});
it('defaults legacy state to zero rounds and rejects malformed counters', () => {
  const state = {
    version: 1,
    hash: hashBody('legacy'),
    reviewed_hash: '',
    last_run: '',
  };
  const body = (value: unknown) =>
    `<!-- ai-factory:req-state ${JSON.stringify(value)} -->`;
  expect(parseState([{ id: 1, body: body(state) }])?.review_rounds).toBe(0);
  for (const review_rounds of [-1, 1.5, '1'])
    expect(
      parseState([{ id: 1, body: body({ ...state, review_rounds }) }]),
    ).toBeNull();
});
