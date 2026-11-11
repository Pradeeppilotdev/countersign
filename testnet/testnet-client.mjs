import assert from 'node:assert/strict';
import {createHash, createPrivateKey} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {connect, KeyPair, keyStores, transactions, utils} from 'near-api-js';
import {testnetConfig} from './testnet.mjs';

export const testnetDirectory = fileURLToPath(new URL('../work/testnet/', import.meta.url));
export const cafeDirectory = join(testnetDirectory, 'cafe');
export async function retryRateLimited(call, wait = delay) {
  for (let attempt = 0; ; attempt++) {
    try { return await call(); }
    catch (error) {
      if (attempt >= 3 || !(error.cause === 429 || /"code"\s*:\s*-429/.test(error.message))) throw error;
      await wait((attempt + 1) * 10_000);
    }
  }
}
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
export function saveJson(path, value) {
  mkdirSync(join(path, '..'), {recursive: true, mode: 0o700});
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flush: true});
  renameSync(path + '.tmp', path);
}
export function success(outcome) {
  assert.ok(Object.hasOwn(outcome.status, 'SuccessValue'), JSON.stringify(outcome.status));
  const raw = Buffer.from(outcome.status.SuccessValue, 'base64').toString();
  return raw ? JSON.parse(raw) : null;
}
export function contractError(outcome) {
  const error = outcome.status?.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  assert.equal(typeof error, 'string', 'Expected an executed contract rejection, not a transport error');
  return error;
}
export function evidence(outcome) {
  return {hash: outcome.transaction.hash, link: `https://testnet.nearblocks.io/txns/${outcome.transaction.hash}`,
    signer: outcome.transaction.signer_id, receiver: outcome.transaction.receiver_id,
    actions: outcome.transaction.actions, status: outcome.status, block_hash: outcome.transaction_outcome.block_hash,
    receipts: outcome.receipts_outcome.map(r => ({id: r.id, executor: r.outcome.executor_id, status: r.outcome.status, logs: r.outcome.logs}))};
}
function expiredTransaction(error) {
  return error?.type === 'Expired' || /\btransaction (?:has )?expired\b/i.test(error?.message ?? '');
}
function unknownTransaction(error) {
  return [error?.type, error?.name, error?.cause?.name].some(type => ['UNKNOWN_TRANSACTION', 'UnknownTransaction'].includes(type)) ||
    /\bUNKNOWN_TRANSACTION\b|\bunknown transaction\b|\btransaction\b.*\b(?:not found|does not exist|doesn't exist)\b/i.test(error?.message ?? '');
}
function validateSignedBytes(record, request) {
  const bytes = Buffer.from(record.signed_transaction_base64, 'base64');
  assert.equal(bytes.toString('base64'), record.signed_transaction_base64, 'Invalid saved transaction encoding');
  const signed = transactions.SignedTransaction.decode(bytes);
  const hash = createHash('sha256').update(transactions.encodeTransaction(signed.transaction)).digest();
  assert.equal(utils.serialize.base_encode(hash), record.hash, 'Saved transaction bytes do not match the recorded hash');
  assert.equal(signed.transaction.signerId, request.signer, 'Saved transaction signer changed');
  assert.equal(signed.transaction.receiverId, request.receiver, 'Saved transaction receiver changed');
}
// Save the complete signed envelope before sending. Replays use identical bytes,
// hash and nonce; neither a crash nor an unknown outcome authorizes another signature.
export async function recordedCall({path, provider, sign, request}) {
  const binding = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  let record;
  if (existsSync(path)) {
    record = readJson(path);
    assert.equal(record.binding, binding, 'Recorded transaction arguments changed');
  } else {
    const [hash, signed] = await sign();
    record = {binding, request, hash: utils.serialize.base_encode(hash),
      signed_transaction_base64: Buffer.from(transactions.encodeTransaction(signed)).toString('base64')};
    validateSignedBytes(record, request);
    saveJson(path, record);
  }
  if (record.state === 'never_sent') throw Error(`Transaction marked never_sent: ${record.reason} No replacement will be signed automatically; manual review required.`);
  if (record.outcome) {
    assert.equal(record.outcome.final_execution_status, 'FINAL');
    assert.equal(record.outcome.transaction.hash, record.hash);
    return record.outcome;
  }
  let outcome;
  if (record.signed_transaction_base64) {
    validateSignedBytes(record, request);
    try {
      outcome = await provider.sendJsonRpc('send_tx', {signed_tx_base64: record.signed_transaction_base64, wait_until: 'FINAL'});
    } catch (sendError) {
      // Already-known/processed transactions (and lost send responses) reconcile
      // to this same hash. An RPC outage is not evidence that a transaction expired.
      try { outcome = await provider.txStatus(record.hash, request.signer, 'FINAL'); }
      catch (statusError) {
        if (expiredTransaction(sendError) && unknownTransaction(statusError)) {
          record.state = 'never_sent';
          record.reason = 'The saved signed transaction expired and the RPC reports it unknown.';
          saveJson(path, record);
          throw Error(`Transaction marked never_sent: ${record.reason} No replacement will be signed automatically; manual review required.`);
        }
        throw Error('Saved transaction is still unconfirmed. Retry will re-broadcast the identical saved bytes, never sign a replacement.', {cause: statusError});
      }
    }
  } else {
    // Existing hash-only journals cannot reconstruct the original signature/nonce.
    try { outcome = await provider.txStatus(record.hash, request.signer, 'FINAL'); }
    catch (error) {
      throw Error('Legacy transaction record has no saved signed bytes and its hash could not be confirmed. Manual reconciliation required; no replacement was signed.', {cause: error});
    }
  }
  if (outcome.final_execution_status !== 'FINAL') outcome = await provider.txStatus(record.hash, request.signer, 'FINAL');
  assert.equal(outcome.final_execution_status, 'FINAL', 'Transaction has not reached FINAL; saved transaction retained');
  assert.equal(outcome.transaction.hash, record.hash, 'RPC outcome does not match the saved transaction');
  record.outcome = outcome;
  saveJson(path, record);
  return outcome;
}
function credential(role, accounts) {
  assert.ok(['owner', 'executor', 'merchant'].includes(role));
  try {
    const saved = readJson(join(testnetDirectory, `${role}.key.json`));
    assert.equal(saved.account_id, accounts[role]);
    const key = KeyPair.fromString(saved.private_key);
    assert.equal(saved.public_key, key.getPublicKey().toString());
    return key;
  } catch { throw Error(`Invalid or missing ${role} credentials under work/testnet`); }
}
export function merchantSigningKey(accounts) {
  const key = credential('merchant', accounts);
  const seed = Buffer.from(utils.serialize.base_decode(key.toString().split(':')[1])).subarray(0, 32);
  return createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8'});
}
export async function testnetClient() {
  const config = testnetConfig(process.env.COUNTERSIGN_NETWORK);
  const accounts = readJson(join(testnetDirectory, 'accounts.json'));
  for (const role of ['owner', 'executor', 'merchant', 'vault']) assert.match(accounts[role], /^countersign-[a-z]+-[a-f0-9]{10}\.testnet$/);
  assert.equal(new Set(Object.values(accounts)).size, 4);
  const keyStore = new keyStores.InMemoryKeyStore();
  const near = await connect({...config, keyStore});
  const provider = near.connection.provider;
  const rpc = provider.sendJsonRpc.bind(provider);
  let nextRequest = 0;
  provider.sendJsonRpc = async (method, params) => {
    await delay(Math.max(0, nextRequest - Date.now()));
    nextRequest = Date.now() + 2000;
    // Retry identical RPC bytes, never generate another transaction or change providers.
    return retryRateLimited(() => rpc(method, params));
  };
  assert.equal((await provider.status()).chain_id, 'testnet');
  return {accounts, provider,
    async view(method_name, args = {}) {
      const value = await provider.query({request_type: 'call_function', account_id: accounts.vault, method_name,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64'), finality: 'final'});
      return JSON.parse(Buffer.from(value.result).toString());
    },
    async balance() {
      const state = await provider.query({request_type: 'view_account', account_id: accounts.merchant, finality: 'final'});
      return {amount: state.amount, block_hash: state.block_hash, block_height: state.block_height};
    },
    async call(role, label, method, args, deposit = '0') {
      assert.match(label, /^[a-z0-9-]+$/);
      const request = {signer: accounts[role], receiver: accounts.vault, method, args, deposit};
      return recordedCall({path: join(cafeDirectory, 'transactions', `${label}.json`), provider, request,
        sign: async () => {
          await keyStore.setKey('testnet', accounts[role], credential(role, accounts));
          const account = await near.account(accounts[role]);
          return account.signTransaction(accounts.vault, [transactions.functionCall(method, args, 100_000_000_000_000n, BigInt(deposit))]);
        }});
    },
  };
}
