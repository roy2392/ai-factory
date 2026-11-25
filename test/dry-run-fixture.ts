import assert from 'node:assert/strict';
import { main } from '../src/cli.js';
import { fixtureEnv, setup } from './helpers.js';

// Exercise the real CLI parser and client wrappers with in-memory reads, never GitHub.
const { state, appClient, userClient } = setup();
let calls = 0;
const result = await main(
  ['dispatch', '--dry-run'],
  fixtureEnv(),
  console.log,
  () => (++calls === 1 ? appClient : userClient),
);
assert.equal(result, 0);
assert.equal(state.writes.length, 0);
console.log('Verified: zero GitHub writes (in-memory fixture).');
