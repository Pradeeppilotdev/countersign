import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import {JsonRpcProvider, SandboxManager} from 'near-workspaces';
import {AgentInbox} from '../agent/inbox.ts';
import {readVaultControls} from '../app/vault-controls.ts';
import {commitment, type Payment} from '../executor/core.ts';
import {vaultReason} from '../executor/errors.ts';
import {matchesInvoiceReceipt, parseSignedInvoice, signedInvoiceHash} from '../merchant/invoice.ts';

import {checkTarget, LocalDeskError, summary, type Target} from './inbox-reader.ts';
export {readTarget, listInvoices, LocalDeskError} from './inbox-reader.ts';

// Use the same signing SDK as near-workspaces. The in-memory signer below
// receives only the executor key, never the sandbox manager's root key.
const sdk = createRequire(createRequire(import.meta.url).resolve('near-workspaces'))('near-api-js');
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
