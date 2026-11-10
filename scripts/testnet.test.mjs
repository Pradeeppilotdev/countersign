import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testnetConfig, deploymentActions, assertInitializedFailure} from './testnet.mjs';

test('testnet requires explicit opt-in and has no configurable RPC or mainnet path', () => {
  for (const network of [undefined, '', 'sandbox', 'mainnet']) assert.throws(() => testnetConfig(network));
  assert.equal(testnetConfig('testnet').nodeUrl, 'https://rpc.testnet.near.org');
});
test('deploy and private initializer are in one ordered action batch', () => {
  const actions = deploymentActions(Buffer.from([0, 97, 115, 109]), 'owner.testnet', 'executor.testnet');
  assert.equal(actions.length, 2);
  assert.ok(actions[0].deployContract);
  assert.equal(actions[1].functionCall.methodName, 'new');
  assert.deepEqual(JSON.parse(Buffer.from(actions[1].functionCall.args)), {owner: 'owner.testnet', executor: 'executor.testnet'});
  assert.equal(actions[1].functionCall.deposit, 0n);
});
test('reinitialization proof rejects unrelated failures and unexpected success', () => {
  assertInitializedFailure({status: {Failure: {error: 'The contract has already been initialized'}}});
  for (const status of [{SuccessValue: ''}, {Failure: 'Method is private'}, {Failure: 'out of gas'}]) {
    assert.throws(() => assertInitializedFailure({status}));
  }
});
