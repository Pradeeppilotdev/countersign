import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {JsonRpcProvider} from 'near-workspaces';
import {AgentInbox} from '../agent/inbox.ts';
import {commitment} from '../executor/core.ts';
import {prepareDemo} from './demo.ts';
import {listInvoices, readTarget, restrictRpc} from './local-vault.ts';

const serverPath = fileURLToPath(new URL('./server.ts', import.meta.url));
const crashHook = fileURLToPath(new URL('../integration/helpers/crash-after-owner-call.ts', import.meta.url));

async function connect(directory: string, options: {crash?: boolean; modern?: boolean} = {}) {
  const client = new Client({name: 'countersign-integration', version: '1.0.0'},
    {versionNegotiation: {mode: options.modern ? {pin: '2026-07-28'} : 'legacy'}});
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', ...(options.crash ? ['--import', crashHook] : []), serverPath],
    env: {COUNTERSIGN_AGENT_DIR: directory, COUNTERSIGN_TEST_OWNER_RECEIPT: 'execute'}, stderr: 'pipe',
  });
  await client.connect(transport);
  return client;
}
const request = (client: Client, id: string) => client.callTool({name: 'request_payment', arguments: {invoice_id: id}});
async function refused(client: Client, name: string, args: Record<string, unknown>, reason: RegExp) {
  const text = await client.callTool({name, arguments: args}).then(reply => {
    assert.equal(reply.isError, true);
    return JSON.stringify(reply.content);
  }, error => String(error));
  assert.match(text, reason);
}

test('the MCP server only attaches to an explicitly chosen, initialized local vault', () => {
  assert.throws(() => readTarget(undefined), /initialized local/);
  assert.throws(() => readTarget('relative'), /initialized local/);
  const dir = mkdtempSync(join(tmpdir(), 'countersign-mcp-empty-'));
  assert.throws(() => readTarget(dir), /already exist/);
  assert.deepEqual(readdirSync(dir), []);
  writeFileSync(join(dir, 'desk.json'), JSON.stringify({session: 'demo', vault: 'vault-12345678.test.near', executor: 'executor.test.near'}));
  writeFileSync(join(dir, 'inbox.db'), '');
  const chain = {homeDir: join(dir, 'chain'), rootAccountId: 'test.near', chainId: 'test-chain-demo', port: 4444, network: 'sandbox'};
  for (const change of [{network: 'mainnet'}, {chainId: 'testnet'}, {port: '443'}, {homeDir: '/another/chain'}]) {
    writeFileSync(join(dir, 'chain.json'), JSON.stringify({...chain, ...change}));
    assert.throws(() => readTarget(dir), /local test vault/);
  }
  writeFileSync(join(dir, 'chain.json'), JSON.stringify(chain));
  const target = readTarget(dir);
  const db = new DatabaseSync(target.db);
  db.exec("CREATE TABLE inbox_scope (id INTEGER PRIMARY KEY, vault TEXT); INSERT INTO inbox_scope VALUES(1,'another vault')");
  db.close();
  assert.throws(() => listInvoices(target), /another vault/);
  writeFileSync(join(dir, 'upgrade-pending.json'), '{}');
  assert.throws(() => listInvoices(target), /upgrade needs verification/);
});

test('the dedicated MCP process cannot send RPC to another endpoint or follow a redirect', async () => {
  let received = 0;
  const destination = createServer((_req, res) => { received++; res.end(); });
  destination.listen(0, '127.0.0.1');
  await once(destination, 'listening');
  const other = 'http://127.0.0.1:' + (destination.address() as AddressInfo).port;
  const rpc = createServer((_req, res) => { res.writeHead(307, {location: other}).end(); });
  const previousFetch = globalThis.fetch;
  try {
    rpc.listen(0, '127.0.0.1');
    await once(rpc, 'listening');
    const url = 'http://127.0.0.1:' + (rpc.address() as AddressInfo).port;
    restrictRpc({rpc: url});
    await assert.rejects(async () => fetch(other), /pinned local RPC/);
    await assert.rejects(fetch(url, {method: 'POST'}), /fetch failed|redirect/i);
    assert.equal(received, 0);
  } finally {
    globalThis.fetch = previousFetch;
    await Promise.all([rpc, destination].map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  }
});

test('two signed bills through MCP, a worker crash and retries credit 0.04 local NEAR once', {timeout: 240_000}, async t => {
  const demo = await prepareDemo();
  const target = readTarget(demo.directory);
  const provider = JsonRpcProvider.from(target.rpc);
  const clients: Client[] = [];
  t.after(async () => {
    try { await Promise.allSettled(clients.map(c => c.close())); }
    finally { process.kill(JSON.parse(readFileSync(join(demo.directory, 'chain.json'), 'utf8')).pid, 'SIGTERM'); }
  });
  const view = async (method: string, args: Record<string, unknown> = {}) => {
    const r = await provider.viewCall(demo.vault, method, args, {finality: 'final'});
    return JSON.parse(Buffer.from(r.result).toString());
  };
  const balance = async () => BigInt((await provider.viewAccount(demo.merchant, {finality: 'final'})).amount);
  const before = await balance(), available = BigInt(await view('available_balance'));
  const amount = 4n * 10n ** 22n;
  const [a, b] = ['CAFE-WEEK-A', 'CAFE-WEEK-B'];
  const lookup = (sql: string, id: string) => {
    const db = new DatabaseSync(target.db, {readOnly: true});
    try { return db.prepare(sql).get(id); } finally { db.close(); }
  };
  const signedA = JSON.parse(String(lookup('SELECT signed_invoice FROM inbox WHERE id=?', a)!.signed_invoice));
  const intake = new AgentInbox(target.db, target.identity, {view, call: async () => { throw Error('no payment capability'); }});
  try {
    const unsigned = {...signedA.invoice, id: 'UNSIGNED'};
    intake.enqueue(unsigned, signedA.merchant_id);
    await assert.rejects(intake.enqueueSigned({...signedA, invoice: {...signedA.invoice, id: 'FORGED', amount: '1'}}, demo.vault), /Invalid merchant signature/);
  } finally { intake.close(); }

  const dying = await connect(demo.directory, {crash: true});
  clients.push(dying);
  const {tools} = await dying.listTools();
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['list_invoices', 'request_payment']);
  assert.equal(tools.find(tool => tool.name === 'list_invoices')?.annotations?.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'request_payment')?.inputSchema.additionalProperties, false);
  const list = await dying.callTool({name: 'list_invoices', arguments: {}});
  assert.ok(!list.isError);
  const invoices = list.structuredContent!.invoices as Record<string, unknown>[];
  assert.deepEqual(invoices.map(i => [i.invoice_id, i.amount_near, i.inbox_state]), [[a, '0.04', 'queued'], [b, '0.04', 'queued']]);
  assert.deepEqual(invoices.map(i => i.service), [demo.service, demo.service]);
  assert(!JSON.stringify(list).includes(signedA.signature));
  await refused(dying, 'request_payment', {invoice_id: a, amount: '1', payee: 'redirect.test.near'}, /unrecognized|additional|invalid/i);
  await refused(dying, 'list_invoices', {path: '/tmp'}, /unrecognized|additional|invalid/i);
  await refused(dying, 'request_payment', {invoice_id: 'UNSIGNED'}, /signed invoice required/i);
  await refused(dying, 'request_payment', {invoice_id: 'FORGED'}, /unknown inbox invoice/i);
  await refused(dying, 'set_policy', {}, /not found|unknown|not registered/i);
  assert.equal(await view('get_payment', {invoice_id: a}), null);
  assert.equal(await balance(), before);

  // The test-only preload kills the real MCP subprocess on the successful
  // execute receipt, before AgentInbox can save or respond to the client's call.
  const crash = await request(dying, a).then(reply => ({reply}), error => ({error}));
  assert.ok('error' in crash, JSON.stringify(crash));
  assert.match(String(crash.error), /closed|disconnect|transport/i);
  let settled = await view('get_payment', {invoice_id: a});
  for (let i = 0; settled?.state !== 'Settled' && i < 40; i++) {
    await delay(150);
    settled = await view('get_payment', {invoice_id: a});
  }
  assert.equal(settled.state, 'Settled');
  const attempt = lookup('SELECT attempt_id,state FROM attempts WHERE invoice_id=?', a);
  assert.deepEqual([attempt?.state, attempt?.attempt_id], ['claimed', settled.attempt_id]);
  assert.equal(await balance() - before, amount);
  assert.equal(BigInt(await view('available_balance')), available - amount);

  const first = await connect(demo.directory), second = await connect(demo.directory, {modern: true});
  clients.push(first, second);
  for (let round = 0; round < 2; round++) {
    const [winner, loser] = await Promise.all([request(first, a), request(second, b)]);
    assert.ok(!winner.isError, JSON.stringify(winner.content));
    assert.equal(winner.structuredContent?.inbox_state, 'settled');
    const receipt = winner.structuredContent!.receipt as Record<string, unknown>;
    assert.equal(receipt.state, 'Settled');
    assert.equal(receipt.attempt_id, attempt!.attempt_id);
    assert.equal(receipt.signed_payload_hash, (await view('get_invoice_auth', {invoice_id: a})).payload_hash);
    assert.equal(loser.isError, true);
    assert.equal(loser.structuredContent?.inbox_state, 'period_claimed');
    assert.equal(loser.structuredContent?.reason, 'service period already claimed by [' + a + ']');
    assert.equal(loser.structuredContent?.receipt, null);
    assert.equal(await balance() - before, amount);
  }
  assert.equal((await view('get_service_claim', {service: demo.service})), a);
  assert.equal((await view('get_payment', {invoice_id: b})), null);
  assert.equal(await view('policy_usage'), String(amount));
  assert.equal(lookup('SELECT state FROM attempts WHERE invoice_id=?', a)?.state, 'settled');
  assert.equal(lookup('SELECT state FROM attempts WHERE invoice_id=?', b), undefined);
  console.log('PASS: MCP worker killed after settlement; two clients retried both bills twice. Merchant +0.04 local NEAR; retries +0.00.');

  // A local terminal row or identical transfer terms do not prove which
  // signed bill settled. Reconciliation must bind the receipt to its payload.
  const db = new DatabaseSync(target.db);
  try {
    const another = {...signedA, bill_id: 'another-bill'};
    assert.equal(commitment(another.invoice), commitment(signedA.invoice));
    db.prepare('UPDATE inbox SET signed_invoice=? WHERE id=?').run(JSON.stringify(another), a);
  } finally { db.close(); }
  await refused(first, 'request_payment', {invoice_id: a}, /different signed bill/i);
  assert.equal(await balance() - before, amount);
});
