import { describe, expect, it } from 'vitest';
import { findMarkers, marker } from '../src/markers.js';

describe('markers', () => {
  it('round trips attributes and JSON, tolerating surrounding whitespace', () => {
    const text = marker(
      'task',
      { req: '12', id: 'task-one/v1.2' },
      { nested: [1, true, null] },
    );
    expect(findMarkers(`body\n${text}\nfooter`, 'task')).toEqual([
      {
        attrs: { req: '12', id: 'task-one/v1.2' },
        json: { nested: [1, true, null] },
      },
    ]);
    expect(
      findMarkers('<!--  ai-factory:plan \n state=ready\t -->', 'plan'),
    ).toEqual([{ attrs: { state: 'ready' } }]);
    expect(findMarkers(marker('plan'), 'plan')).toEqual([{ attrs: {} }]);
    expect(findMarkers(marker('plan', {}, false), 'plan')[0]?.json).toBe(false);
  });
  it('ignores malformed, wrong-kind, duplicate-key, and incomplete markers', () => {
    const text = [
      '<!-- ai-factory:task id=bad value -->',
      '<!-- ai-factory:task {broken} -->',
      '<!-- ai-factory:task id=a id=b -->',
      '<!-- ai-factory:plan -->',
      '<!-- ai-factory:task id=unfinished',
    ].join('\n');
    expect(findMarkers(text, 'task')).toEqual([]);
  });
  it('escapes comment terminators in JSON and restores them on read', () => {
    const value = { text: 'before --> after >', nested: ['-->'] };
    const text = marker('req-state', {}, value);
    expect(text.match(/-->/g)).toHaveLength(1);
    expect(text).toContain('\\u003e');
    expect(findMarkers(text, 'req-state')[0]?.json).toEqual(value);
  });
  it.each(['', 'has space', 'x=y', 'x-->y', '<script>', 'newline\n', 'hello"'])(
    'throws for bad attribute value %j',
    (value) => {
      expect(() => marker('task', { id: value })).toThrow(
        'Invalid marker attribute',
      );
    },
  );
  it('rejects invalid kinds, keys and unserializable JSON', () => {
    expect(() => marker('bad kind')).toThrow();
    expect(() => marker('task', { 'bad key': 'value' })).toThrow();
    expect(() => marker('task', {}, () => {})).toThrow();
  });
});
