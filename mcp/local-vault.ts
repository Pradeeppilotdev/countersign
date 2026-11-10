import {existsSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {isAbsolute, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import {JsonRpcProvider, SandboxManager} from 'near-workspaces';
import {AgentInbox} from '../agent/inbox.ts';
import {requireUpgradeVerified} from '../app/upgrade-state.ts';
import {readVaultControls} from '../app/vault-controls.ts';
import {commitment, type Payment} from '../executor/core.ts';
import {vaultReason} from '../executor/errors.ts';
import {matchesInvoiceReceipt, parseSignedInvoice, signedInvoiceHash, type SignedInvoice} from '../merchant/invoice.ts';

// Use the same signing SDK as near-workspaces. The in-memory signer below
// receives only the executor key, never the sandbox manager's root key.
const sdk = createRequire(createRequire(import.meta.url).resolve('near-workspaces'))('near-api-js');
export class LocalDeskError extends Error {}

export function readTarget(directory: string | undefined) {
  if (!directory || !isAbsolute(directory)) throw new LocalDeskError('Set COUNTERSIGN_AGENT_DIR to an initialized local agent vault.');
  directory = resolve(directory);
  requireUpgradeVerified(directory);
  const db = join(directory, 'inbox.db');
  if (![db, join(directory, 'desk.json'), join(directory, 'chain.json')].every(path => existsSync(path))) {
    throw new LocalDeskError('The selected local vault and signed inbox must already exist.');
  }
  const desk = JSON.parse(readFileSync(join(directory, 'desk.json'), 'utf8'));
  const chain = JSON.parse(readFileSync(join(directory, 'chain.json'), 'utf8'));
  const executor = desk.executor ?? 'executor.test.near';
  if (chain.network !== 'sandbox' || chain.rootAccountId !== 'test.near' || chain.homeDir !== join(directory, 'chain') ||
      !Number.isInteger(chain.port) || chain.port <= 1024 || chain.port >= 65536 ||
      !/^test-chain-[A-Za-z0-9_-]+$/.test(chain.chainId ?? '') || !/^vault-[a-f0-9]{8}\.test\.near$/.test(desk.vault ?? '') ||
      !/^executor(?:-[a-z0-9]+)*\.test\.near$/.test(executor) || typeof desk.session !== 'string' || !desk.session) {
    throw new LocalDeskError('Expected a Countersign local test vault.');
  }
  return {directory, db, identity: desk.session + ':' + desk.vault, vault: String(desk.vault), executor: String(executor),
    chainId: String(chain.chainId), homeDir: String(chain.homeDir), port: Number(chain.port), rpc: 'http://127.0.0.1:' + chain.port};
}
type Target = ReturnType<typeof readTarget>;

function checkTarget(target: Target) {
  const current = readTarget(target.directory);
  if (current.identity !== target.identity || current.chainId !== target.chainId || current.rpc !== target.rpc || current.executor !== target.executor) {
    throw new LocalDeskError('The local vault or executor changed. Reconnect the MCP client.');
  }
  const db = new DatabaseSync(target.db, {readOnly: true});
  try {
    if (db.prepare('SELECT vault FROM inbox_scope WHERE id=1').get()?.vault !== target.identity) {
      throw new LocalDeskError('The signed inbox belongs to another vault.');
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

function summary(signed: SignedInvoice, state: string) {
  return {invoice_id: signed.invoice.id, bill_id: signed.bill_id, merchant_id: signed.merchant_id,
    payee: signed.invoice.payee, amount_near: sdk.utils.format.formatNearAmount(signed.invoice.amount, 24),
    service: signed.service ?? null, inbox_state: state};
}

export function listInvoices(target: Target) {
  const db = checkTarget(target);
  try {
    // Older inboxes have no signed bills. Listing must never migrate them.
    const columns = db.prepare('PRAGMA table_info(inbox)').all();
    const rows = columns.some(c => c.name === 'signed_invoice')
      ? db.prepare('SELECT id, commitment, merchant, signed_invoice, state FROM inbox WHERE signed_invoice IS NOT NULL ORDER BY rowid').all() : [];
    const invoices = rows.map(row => {
      const signed = parseSignedInvoice(JSON.parse(String(row.signed_invoice)));
      if (signed.vault !== target.vault || signed.invoice.id !== row.id || signed.merchant_id !== row.merchant || commitment(signed.invoice) !== row.commitment) {
        throw new LocalDeskError('A signed bill does not match the stored inbox record.');
      }
      return summary(signed, String(row.state));
    });
    return {network: 'LOCAL_SANDBOX', vault: target.vault, invoices};
  } finally { db.close(); }
}

// The NEAR SDK uses process fetch for RPC and retries. This dedicated stdio
// process may contact exactly its pinned loopback endpoint, including redirects.
export function restrictRpc(target: Pick<Target, 'rpc'>) {
  const allowed = new URL(target.rpc).href;
  const fetchRpc = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).href !== allowed) throw new LocalDeskError('Only the pinned local RPC is available.');
    return fetchRpc(input, {...init, redirect: 'error', signal: init?.signal ?? AbortSignal.timeout(30_000)});
  };
  sdk.utils.Logger.overrideLogger();
  process.env.NEAR_WORKSPACES_NO_LOGS = '1';
}

export async function requestPayment(target: Target, id: string) {
  // Share the operator's vault lock so upgrades, rotation and a request cannot
  // switch the target underneath each other. A killed client leaves a stale lock.
  const release = await lockfile.lock(target.directory, {stale: 2000, update: 1000, retries: {retries: 30, minTimeout: 100, maxTimeout: 350}});
  let inbox: AgentInbox | undefined;
  try {
    checkTarget(target).close();
    const provider = JsonRpcProvider.from(target.rpc);
    if ((await provider.status()).chain_id !== target.chainId) throw new LocalDeskError('Local chain identity mismatch.');
    const view = async (method: string, args: Record<string, unknown>, block?: string) => {
      // Match the existing executor's read-after-write behavior. The receipt
      // returned to the client is independently read at a finalized block.
      const result = await provider.viewCall(target.vault, method, args, block ? {block_id: block} : {finality: 'optimistic'});
      return JSON.parse(Buffer.from(result.result).toString());
    };
    const controls = await readVaultControls({view});
    if (!controls || controls.owner !== 'owner.test.near' || controls.executor !== target.executor) throw new LocalDeskError('The local vault executor does not match this connection.');
    if (controls.paused) throw new LocalDeskError('Vault payments paused.');
    const disk = new sdk.keyStores.UnencryptedFileSystemKeyStore(target.homeDir);
    const key = await disk.getKey('sandbox', target.executor);
    if (!key) throw new LocalDeskError('The local executor key is unavailable.');
    const keyStore = new sdk.keyStores.InMemoryKeyStore();
    await keyStore.setKey('sandbox', target.executor, key);
    const manager = new SandboxManager({network: 'sandbox', rootAccountId: 'test.near', homeDir: target.homeDir,
      port: target.port, rpcAddr: target.rpc, keyStore, rm: false, refDir: null});
    const executor = manager.getAccount(target.executor);
    inbox = new AgentInbox(target.db, target.identity, {view, call(method, args) {
      if (!['authorize_signed_invoice', 'reserve', 'execute'].includes(method)) throw new LocalDeskError('Unsupported payment operation.');
      return executor.call(target.vault, method, args, {gas: '100000000000000'});
    }});
    const row = await inbox.requestSignedPayment(id);
    const signed = parseSignedInvoice(row.signed_invoice);
    const readFinal = async () => {
      const block = (await provider.block({finality: 'final'})).header.hash;
      const payment: Payment | null = await view('get_payment', {invoice_id: id}, block);
      return {block, payment};
    };
    let observed = await readFinal();
    const terminal = row.state === 'settled' ? 'Settled' : row.state === 'failed' ? 'Failed' : null;
    for (let i = 0; terminal && observed.payment?.state !== terminal && i < 25; i++) {
      await delay(200);
      observed = await readFinal();
    }
    if (terminal && observed.payment?.state !== terminal) throw new LocalDeskError('Payment outcome is unconfirmed. Retry the same invoice ID.');
    const {block, payment} = observed;
    let receipt = null;
    if (payment) {
      const auth = await view('get_invoice_auth', {invoice_id: id}, block);
      if (payment.commitment !== commitment(signed.invoice) || commitment(payment.invoice) !== payment.commitment || !matchesInvoiceReceipt(signed, auth)) {
        throw new LocalDeskError('The vault record belongs to a different signed bill.');
      }
      receipt = {state: payment.state, attempt_id: payment.attempt_id, block_hash: block, signed_payload_hash: signedInvoiceHash(signed)};
    }
    const reason = row.error ? vaultReason(Error(String(row.error))) ?? 'Outcome unconfirmed. Retry the same invoice ID.' : null;
    return {network: 'LOCAL_SANDBOX', vault: target.vault, ...summary(signed, String(row.state)), receipt, reason};
  } finally {
    try { inbox?.close(); } finally { await release(); }
  }
}
