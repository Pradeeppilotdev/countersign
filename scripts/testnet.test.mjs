import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testnetConfig, deploymentActions, assertInitializedFailure} from './testnet.mjs';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync, rmSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {utils} from 'near-api-js';
import {cafeInvoices} from './testnet-cafe.mjs';
import {recordedCall, testnetDirectory, retryRateLimited} from './testnet-client.mjs';
import {publicKeyBase64, verifySignedInvoice} from '../merchant/invoice.ts';

test('testnet requires explicit opt-in and has no configurable RPC or mainnet path', () => {
  for (const network of [undefined, '', 'sandbox', 'mainnet']) assert.throws(() => testnetConfig(network));
  assert.equal(testnetConfig('testnet').nodeUrl, 'https://test.rpc.fastnear.com');
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

test('café adversarial fixtures isolate signature, bill-reuse and rolling-budget checks', () => {
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const accounts = {merchant: 'merchant.testnet', owner: 'owner.testnet', vault: 'vault.testnet'};
  const invoices = cafeInvoices(accounts, privateKey, 'ab'.repeat(32), String(Date.now() + 3600000), 'fixture');
  const expected = {vault: accounts.vault, domain: 'ab'.repeat(32), key: {version: '1', public_key: publicKeyBase64(publicKey)}};
  for (const name of ['paid', 'duplicate', 'over_budget', 'restart']) verifySignedInvoice(invoices[name], expected);
  assert.throws(() => verifySignedInvoice(invoices.tampered, expected), /Invalid merchant signature/);
  assert.equal(invoices.duplicate.bill_id, invoices.paid.bill_id);
  assert.notEqual(invoices.duplicate.invoice.id, invoices.paid.invoice.id);
  assert.equal(BigInt(invoices.over_budget.invoice.amount), 5n * 10n ** 23n);
  assert.ok(BigInt(invoices.paid.invoice.amount) + BigInt(invoices.over_budget.invoice.amount) > 8n * 10n ** 23n);
  assert.ok(BigInt(invoices.paid.invoice.amount) + BigInt(invoices.restart.invoice.amount) <= 8n * 10n ** 23n);
});

test('uncertain testnet send reconciles its saved hash without signing or sending again', async () => {
  mkdirSync(testnetDirectory, {recursive: true, mode: 0o700});
  const directory = mkdtempSync(join(testnetDirectory, 'journal-test-'));
  try {
    const hash = Buffer.alloc(32, 1), encoded = utils.serialize.base_encode(hash);
    let signatures = 0, sends = 0, queries = 0;
    const outcome = {final_execution_status: 'FINAL', transaction: {hash: encoded}, status: {SuccessValue: ''}};
    const options = {path: join(directory, 'call.json'), request: {signer: 'owner.testnet', deposit: '2'},
      sign: async () => { signatures++; return [hash, {}]; }, provider: {
        async sendTransactionUntil() { sends++; throw Error('lost response'); },
        async txStatus(saved, signer) { queries++; assert.equal(saved, encoded); assert.equal(signer, 'owner.testnet'); return outcome; },
      }};
    await assert.rejects(() => recordedCall(options), /lost response/);
    assert.deepEqual(await recordedCall(options), outcome);
    assert.deepEqual(await recordedCall(options), outcome);
    await assert.rejects(() => recordedCall({...options, request: {...options.request, deposit: '3'}}), /arguments changed/);
    assert.deepEqual([signatures, sends, queries], [1, 1, 1]);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('public RPC rate limits back off finitely; contract errors are never retried', async () => {
  const waits = []; let calls = 0;
  assert.equal(await retryRateLimited(async () => {
    if (++calls < 3) throw Object.assign(Error('rate limit'), {cause: 429});
    return 'same request completed';
  }, async ms => { waits.push(ms); }), 'same request completed');
  assert.deepEqual(waits, [10000, 20000]);
  calls = 0;
  await assert.rejects(() => retryRateLimited(async () => { calls++; throw Error('contract rejected'); }, async () => {}), /contract rejected/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(() => retryRateLimited(async () => { calls++; throw Object.assign(Error('still limited'), {cause: 429}); }, async () => {}), /still limited/);
  assert.equal(calls, 4);
});
