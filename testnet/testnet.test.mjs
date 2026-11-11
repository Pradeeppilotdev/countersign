import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testnetConfig, deploymentActions, assertInitializedFailure} from './testnet.mjs';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtempSync, rmSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {KeyPair, transactions, utils} from 'near-api-js';
import {cafeInvoices} from './testnet-cafe.mjs';
import {recordedCall, readJson, saveJson, retryRateLimited} from './testnet-client.mjs';
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

const rpcError=type=>Object.assign(Error(type),{type});
async function journalFixture(t){
 const directory=mkdtempSync(join(tmpdir(),'countersign-journal-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const path=join(directory,'call.json');
 const pair=KeyPair.fromRandom('ed25519'); // Only in memory; no real account or network.
 const signer={getPublicKey:async()=>pair.getPublicKey(),signMessage:async bytes=>pair.sign(createHash('sha256').update(bytes).digest())};
 const request={signer:'owner.testnet',receiver:'vault.testnet',method:'fund',args:{},deposit:'2'};
 const signed=await transactions.signTransaction(request.receiver,42n,[transactions.functionCall('fund',{},100_000_000_000_000n,2n)],Buffer.alloc(32,3),signer,request.signer,'testnet');
 const hash=utils.serialize.base_encode(signed[0]);
 const bytes=Buffer.from(transactions.encodeTransaction(signed[1])).toString('base64');
 const outcome={final_execution_status:'FINAL',transaction:{hash},status:{SuccessValue:''}};
 const counts={signatures:0,sends:0,queries:0};
 const sent=[];
 const provider={
  async sendJsonRpc(method,params){
   counts.sends++;assert.equal(method,'send_tx');assert.equal(params.wait_until,'FINAL');
   assert.equal(params.signed_tx_base64,bytes);sent.push(params.signed_tx_base64);
   const saved=readJson(path);assert.equal(saved.hash,hash);assert.equal(saved.signed_transaction_base64,bytes);
   return outcome;
  },
  async txStatus(saved,account,wait){counts.queries++;assert.equal(saved,hash);assert.equal(account,request.signer);assert.equal(wait,'FINAL');return outcome;},
 };
 const options={path,provider,request,sign:async()=>{counts.signatures++;return signed;}};
 return {directory,path,hash,bytes,outcome,counts,sent,provider,options};
}

test('crash after journal save but before broadcast retries the identical signed bytes and one hash',async t=>{
 const f=await journalFixture(t);
 const send=f.provider.sendJsonRpc;
 f.provider.sendJsonRpc=async()=>{
  // The process can stop here with a complete journal but no accepted RPC request.
  assert.equal(readJson(f.path).signed_transaction_base64,f.bytes);
  throw Error('simulated crash before RPC send');
 };
 f.provider.txStatus=async()=>{throw rpcError('UNKNOWN_TRANSACTION');};
 await assert.rejects(()=>recordedCall(f.options),/still unconfirmed/);
 assert.equal(f.counts.sends,0);
 f.provider.sendJsonRpc=send;
 assert.deepEqual(await recordedCall(f.options),f.outcome);
 assert.deepEqual(await recordedCall(f.options),f.outcome); // Final result is cached.
 assert.deepEqual(f.sent,[f.bytes]);
 assert.equal(f.counts.signatures,1);
 assert.deepEqual(readdirSync(f.directory),['call.json']);
 const record=readJson(f.path);
 assert.equal(record.hash,f.hash);assert.deepEqual(record.outcome,f.outcome);
 assert.equal(transactions.SignedTransaction.decode(Buffer.from(record.signed_transaction_base64,'base64')).transaction.nonce,42n);
});

test('already processed on identical re-broadcast falls back to FINAL status for the same hash',async t=>{
 const f=await journalFixture(t);
 const send=f.provider.sendJsonRpc;
 f.provider.sendJsonRpc=async(...args)=>{await send(...args);throw Error('Transaction already processed');};
 // Simulate a lost response after acceptance, with the status read unavailable too.
 const status=f.provider.txStatus;
 f.provider.txStatus=async()=>{throw Error('RPC disconnected');};
 await assert.rejects(()=>recordedCall(f.options),/still unconfirmed/);
 f.provider.txStatus=status;
 assert.deepEqual(await recordedCall(f.options),f.outcome);
 assert.deepEqual(f.sent,[f.bytes,f.bytes]);
 assert.deepEqual(f.counts,{signatures:1,sends:2,queries:1});
});

test('expired and unknown marks never_sent and never signs a replacement',async t=>{
 const f=await journalFixture(t);
 f.provider.sendJsonRpc=async()=>{f.counts.sends++;throw rpcError('Expired');};
 f.provider.txStatus=async()=>{f.counts.queries++;throw rpcError('UNKNOWN_TRANSACTION');};
 await assert.rejects(()=>recordedCall(f.options),/never_sent.*expired.*unknown.*No replacement/);
 const record=readJson(f.path);assert.equal(record.state,'never_sent');assert.equal(record.hash,f.hash);assert.equal(record.signed_transaction_base64,f.bytes);
 await assert.rejects(()=>recordedCall(f.options),/manual review required/);
 assert.deepEqual(f.counts,{signatures:1,sends:1,queries:1});
});

test('expired broadcast with an existing FINAL receipt preserves the outcome',async t=>{
 const f=await journalFixture(t);
 f.provider.sendJsonRpc=async()=>{throw rpcError('Expired');};
 assert.deepEqual(await recordedCall(f.options),f.outcome);
 assert.equal(readJson(f.path).state,undefined);
 assert.equal(f.counts.signatures,1);
});

test('an RPC outage after expired broadcast is not classified as never_sent',async t=>{
 const f=await journalFixture(t);
 f.provider.sendJsonRpc=async()=>{throw rpcError('Expired');};
 f.provider.txStatus=async()=>{throw Error('RPC unavailable');};
 await assert.rejects(()=>recordedCall(f.options),/still unconfirmed/);
 assert.equal(readJson(f.path).state,undefined);assert.equal(f.counts.signatures,1);
});

test('changed arguments are rejected before re-broadcasting or signing',async t=>{
 const f=await journalFixture(t);
 await recordedCall(f.options);
 await assert.rejects(()=>recordedCall({...f.options,request:{...f.options.request,deposit:'3'}}),/arguments changed/);
 assert.deepEqual(f.counts,{signatures:1,sends:1,queries:0});
});

test('legacy hash-only records query once, then stop clearly if unknown',async t=>{
 const f=await journalFixture(t);
 await recordedCall(f.options);
 const old=readJson(f.path);delete old.signed_transaction_base64;delete old.outcome;saveJson(f.path,old);
 f.provider.txStatus=async()=>{f.counts.queries++;throw rpcError('UNKNOWN_TRANSACTION');};
 await assert.rejects(()=>recordedCall(f.options),/Legacy transaction record.*no saved signed bytes.*Manual reconciliation required/);
 assert.deepEqual(f.counts,{signatures:1,sends:1,queries:1});
});

test('legacy hash-only records still reconcile a known FINAL outcome without signing',async t=>{
 const f=await journalFixture(t);
 await recordedCall(f.options);
 const old=readJson(f.path);delete old.signed_transaction_base64;delete old.outcome;saveJson(f.path,old);
 assert.deepEqual(await recordedCall(f.options),f.outcome);
 assert.deepEqual(f.counts,{signatures:1,sends:1,queries:1});
});

test('non-final sends wait for FINAL and corrupted saved bytes never reach the provider',async t=>{
 const f=await journalFixture(t);
 const send=f.provider.sendJsonRpc;
 f.provider.sendJsonRpc=async(...args)=>({...await send(...args),final_execution_status:'EXECUTED_OPTIMISTIC'});
 assert.deepEqual(await recordedCall(f.options),f.outcome);
 const record=readJson(f.path);delete record.outcome;record.hash=utils.serialize.base_encode(Buffer.alloc(32,9));saveJson(f.path,record);
 await assert.rejects(()=>recordedCall(f.options),/bytes do not match/);
 assert.deepEqual(f.counts,{signatures:1,sends:1,queries:1});
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
