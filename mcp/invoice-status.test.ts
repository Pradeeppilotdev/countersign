import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {commitment, type Payment} from '../executor/core.ts';
import {signInvoice, signedInvoiceHash} from '../merchant/invoice.ts';
import {invoiceStatus} from './invoice-status.ts';
import {readTarget} from './inbox-reader.ts';

const block = 'B'.repeat(44);
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'countersign-status-'));
  const identity = {session: 'read-only-test', vault: 'vault-12345678.test.near', executor: 'executor.test.near'};
  const chain = {network: 'sandbox', rootAccountId: 'test.near', homeDir: join(directory, 'chain'),
    port: 4444, chainId: 'test-chain-receipts'};
  writeFileSync(join(directory, 'desk.json'), JSON.stringify(identity));
  writeFileSync(join(directory, 'chain.json'), JSON.stringify(chain));
  const signed = signInvoice({invoice: {id: 'BILL-A', payee: 'merchant.test.near', amount: '40000000000000000000000', asset: 'near'},
    merchant_id: 'cafe', bill_id: 'receipt-a', vault: identity.vault, domain: 'a'.repeat(64), key_version: '1',
    expires_at: '1', service: {agreement_id: 'weekly', period_start_ms: '0'}}, generateKeyPairSync('ed25519').privateKey);
  const db = new DatabaseSync(join(directory, 'inbox.db'));
  db.exec('CREATE TABLE inbox_scope(id INTEGER PRIMARY KEY, vault TEXT); CREATE TABLE inbox(id TEXT PRIMARY KEY, invoice TEXT, commitment TEXT, merchant TEXT, signed_invoice TEXT, state TEXT)');
  db.prepare('INSERT INTO inbox_scope VALUES(1,?)').run(identity.session + ':' + identity.vault);
  db.prepare('INSERT INTO inbox VALUES(?,?,?,?,?,?)').run(signed.invoice.id, JSON.stringify(signed.invoice), commitment(signed.invoice), signed.merchant_id, JSON.stringify(signed), 'proposal_ready');
  db.close();
  return {directory, identity, chain, signed, target: readTarget(directory)};
}
type Fixture = ReturnType<typeof fixture>;
function response(f: Fixture, payment: Payment | null, options: {auth?: unknown; claim?: string | null;
  queryBlock?: string; chainId?: string; intercept?: () => void; fail?: boolean} = {}) {
  const calls: string[] = [];
  const send: typeof fetch = async (url, init) => {
    assert.equal(url, f.target.rpc);
    assert.equal(init?.redirect, 'error');
    const {method, params} = JSON.parse(String(init?.body));
    assert(['status', 'block', 'query'].includes(method), 'Only read RPC methods are possible');
    calls.push(method === 'query' ? params.method_name : method);
    options.intercept?.();
    if (options.fail) throw Error('transport failure with private diagnostics');
    let result;
    if (method === 'status') result = {chain_id: options.chainId ?? f.chain.chainId};
    if (method === 'block') { assert.deepEqual(params, {finality: 'final'}); result = {header: {hash: block, height: 123}}; }
    if (method === 'query') {
      assert.equal(params.block_id, block);
      assert.equal(params.account_id, f.identity.vault);
      assert.equal(params.request_type, 'call_function');
      const values: Record<string, unknown> = {
        get_payment: payment, get_invoice_auth: Object.hasOwn(options, 'auth') ? options.auth : payment ? {payload_hash: signedInvoiceHash(f.signed)} : null,
        get_service_claim: Object.hasOwn(options, 'claim') ? options.claim : payment ? f.signed.invoice.id : null,
        get_vault_controls: {owner: 'owner.test.near', executor: 'executor-next.test.near', paused: true},
      };
      assert(Object.hasOwn(values, params.method_name));
      result = {block_hash: options.queryBlock ?? block, result: [...Buffer.from(JSON.stringify(values[params.method_name]))]};
    }
    return Response.json({jsonrpc: '2.0', id: 'status', result});
  };
  return {send, calls};
}
const paid = (f: Fixture): Payment => ({invoice: f.signed.invoice, commitment: commitment(f.signed.invoice), state: 'Settled', attempt_id: 'same-attempt'});

test('finalized signed receipt overrides stale inbox without keys, inference or writes', async () => {
  const f = fixture(), before = readFileSync(f.target.db), entries = readdirSync(f.directory);
  const {send, calls} = response(f, paid(f));
  // Expired signatures remain attributable through the historical vault receipt.
  const result = await invoiceStatus(f.target, 'BILL-A', send);
  assert.equal(result.payment_confirmed, true);
  assert.equal(result.vault_state, 'Settled');
  assert.equal(result.inbox_state, 'proposal_ready');
  assert.equal(result.receipt?.attempt_id, 'same-attempt');
  assert.deepEqual(result.source, {block_hash: block, block_height: 123, finality: 'final'});
  assert.equal(result.controls.paused, true);
  assert(!JSON.stringify(result).includes(f.signed.signature));
  assert.deepEqual(readFileSync(f.target.db), before);
  assert.deepEqual(readdirSync(f.directory), entries); // No key directory even exists.
  assert.deepEqual(calls.sort(), ['block', 'get_invoice_auth', 'get_payment', 'get_service_claim', 'get_vault_controls', 'status'].sort());
});

test('receipt inspection survives executor rotation but rejects vault or chain replacement', async () => {
  const f = fixture();
  writeFileSync(join(f.directory, 'desk.json'), JSON.stringify({...f.identity, executor: 'executor-next.test.near'}));
  assert.equal((await invoiceStatus(f.target, 'BILL-A', response(f, paid(f)).send)).payment_confirmed, true);
  await assert.rejects(invoiceStatus(f.target, 'BILL-A', response(f, paid(f), {chainId: 'testnet'}).send), /chain identity mismatch/);
  const mutate = () => writeFileSync(join(f.directory, 'desk.json'), JSON.stringify({...f.identity, vault: 'vault-87654321.test.near'}));
  await assert.rejects(invoiceStatus(f.target, 'BILL-A', response(f, paid(f), {intercept: mutate}).send), /vault or executor changed/);
});

test('no finalized receipt is never payment confirmation, even if the inbox says settled', async () => {
  const f = fixture(), db = new DatabaseSync(f.target.db);
  db.prepare("UPDATE inbox SET state='settled'").run(); db.close();
  const result = await invoiceStatus(f.target, 'BILL-A', response(f, null).send);
  assert.equal(result.inbox_state, 'settled'); assert.equal(result.vault_state, null);
  assert.equal(result.payment_confirmed, false); assert.equal(result.receipt, null);
  assert.match(result.message, /not approval to pay/);
  const loser = await invoiceStatus(f.target, 'BILL-A', response(f, null, {claim: 'BILL-B'}).send);
  assert.equal(loser.service_claim, 'BILL-B'); assert.equal(loser.payment_confirmed, false);
  assert.match(loser.message, /claimed by \[BILL-B\]/);
});

test('authorized, reserved, executing, failed and corrected bills never read as paid', async () => {
  const f = fixture();
  for (const state of ['Authorized', 'Reserved', 'Executing', 'Failed', 'Cancelled'] as const) {
    const payment = {...paid(f), state, attempt_id: state === 'Authorized' || state === 'Cancelled' ? null : 'same-attempt'};
    const result = await invoiceStatus(f.target, 'BILL-A', response(f, payment, {claim: state === 'Cancelled' ? 'CORRECTED-BILL' : 'BILL-A'}).send);
    assert.equal(result.vault_state, state); assert.equal(result.payment_confirmed, false);
    assert.equal(result.receipt?.attempt_id, payment.attempt_id);
    if (state === 'Cancelled') assert.equal(result.service_claim, 'CORRECTED-BILL');
  }
});

test('a colliding invoice ID or another signed bill with identical transfer terms cannot borrow a receipt', async () => {
  const f = fixture();
  const other = {...f.signed.invoice, amount: '30000000000000000000000'};
  await assert.rejects(invoiceStatus(f.target, 'BILL-A', response(f, {...paid(f), invoice: other, commitment: commitment(other)}).send), /different signed bill/);
  const auth = {payload_hash: signedInvoiceHash({...f.signed, bill_id: 'another-signed-bill'})};
  await assert.rejects(invoiceStatus(f.target, 'BILL-A', response(f, paid(f), {auth}).send), /different signed bill/);
  await assert.rejects(invoiceStatus(f.target, 'BILL-A', response(f, paid(f), {auth: null}).send), /different signed bill/);
});

test('mixed blocks, missing attempts and RPC errors fail closed without a payment result', async () => {
  const f = fixture();
  await assert.rejects(invoiceStatus(f.target, 'BILL-A', response(f, paid(f), {queryBlock: 'C'.repeat(44)}).send), /inconsistent invoice snapshot/);
  await assert.rejects(invoiceStatus(f.target, 'BILL-A', response(f, {...paid(f), attempt_id: null}).send), /inconsistent invoice receipt/);
  await assert.rejects(invoiceStatus(f.target, 'BILL-A', response(f, null, {auth: {payload_hash: signedInvoiceHash(f.signed)}}).send), /inconsistent invoice receipt/);
  await assert.rejects(invoiceStatus(f.target, 'BILL-A', response(f, paid(f), {fail: true}).send), /^Error: Invoice status could not be confirmed.*No payment was requested/);
});

test('unknown, unsigned and locally altered bills fail before RPC', async () => {
  const f = fixture(), send = async () => { throw Error('RPC must not be called'); };
  await assert.rejects(invoiceStatus(f.target, '../path', send), /Invalid invoice reference/);
  await assert.rejects(invoiceStatus(f.target, 'UNKNOWN', send), /Unknown inbox/);
  const db = new DatabaseSync(f.target.db);
  db.prepare('UPDATE inbox SET invoice=?').run(JSON.stringify({...f.signed.invoice, payee: 'attacker.test.near'}));
  await assert.rejects(invoiceStatus(f.target, 'BILL-A', send), /does not match/);
  db.exec('UPDATE inbox SET signed_invoice=NULL');
  await assert.rejects(invoiceStatus(f.target, 'BILL-A', send), /Signed invoice required/);
  db.close();
});
