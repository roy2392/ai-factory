import { expect, it } from 'vitest';
import { findCycle, topoSort } from '../../src/requirements/graph.js';
import { proposed } from './helpers.js';
it('uses deterministic input-order tie breaking among currently ready nodes', () => {
  expect(
    topoSort([
      proposed('c', ['a']),
      proposed('b'),
      proposed('a'),
      proposed('d'),
    ]).map((t) => t.id),
  ).toEqual(['b', 'a', 'c', 'd']);
});
it('treats existing dependencies as external nodes and reports a closed cycle path', () => {
  expect(topoSort([proposed('a', ['existing'])]).map((t) => t.id)).toEqual([
    'a',
  ]);
  const cyclic = [
    proposed('a', ['b']),
    proposed('b', ['c']),
    proposed('c', ['a']),
  ];
  expect(findCycle(cyclic)).toEqual(['a', 'b', 'c', 'a']);
  expect(() => topoSort(cyclic)).toThrow('a -> b -> c -> a');
  expect(findCycle([proposed('a', ['a'])])).toEqual(['a', 'a']);
});
