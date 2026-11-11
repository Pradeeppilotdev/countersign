// Receipt inspection has no signing, payment, migration or model capability.
// The only network requests are status, block and these pinned contract views.
import {checkTarget, LocalDeskError, summary, type Target} from './inbox-reader.ts';
import {commitment, type Payment} from '../executor/core.ts';
import {matchesInvoiceReceipt, parseSignedInvoice, signedInvoiceHash} from '../merchant/invoice.ts';
import {validAccount} from '../agent/ask/views.ts';

const idPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const states = ['Authorized', 'Reserved', 'Executing', 'Settled', 'Failed', 'Cancelled'];
const messages = {
  Authorized: 'Authorized on chain; payment has not been reserved.',
  Reserved: 'Funds are reserved. No settled transfer is confirmed; keep the same invoice ID.',
  Executing: 'Transfer is in flight. No settled transfer is confirmed; keep the same invoice ID.',
  Settled: 'The vault confirms this exact signed bill settled.',
  Failed: 'The vault confirms the transfer failed. This is not permission to submit a new bill.',
  Cancelled: 'The vault confirms this exact signed bill was cancelled.',
};

export async function invoiceStatus(target: Target, id: string, send: typeof fetch = fetch) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new LocalDeskError('Invalid invoice reference.');
  const db = checkTarget(target, false); // Executor rotation must not hide old receipts.
  let row;
  try {
    row = db.prepare('SELECT id, invoice, commitment, merchant, signed_invoice, state FROM inbox WHERE id=?').get(id);
  } finally { db.close(); }
  if (!row) throw new LocalDeskError('Unknown inbox invoice.');
  if (!row.signed_invoice) throw new LocalDeskError('Signed invoice required for receipt inspection.');
  const signed = parseSignedInvoice(JSON.parse(String(row.signed_invoice)));
  const expected = commitment(signed.invoice);
  if (signed.vault !== target.vault || signed.invoice.id !== id || signed.merchant_id !== row.merchant ||
      expected !== row.commitment || commitment(JSON.parse(String(row.invoice))) !== expected) {
    throw new LocalDeskError('A signed bill does not match the stored inbox record.');
  }
  async function rpc(method: 'status' | 'block' | 'query', params: Record<string, unknown>) {
    try {
      const response = await send(target.rpc, {method: 'POST', redirect: 'error',
        headers: {'Content-Type': 'application/json'}, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({jsonrpc: '2.0', id: 'countersign-invoice-status', method, params})});
      if (!response.ok) throw Error('RPC HTTP error');
      const text = await response.text();
      if (text.length > 262144) throw Error('RPC response too large');
      const reply = JSON.parse(text);
      if (reply.error || !Object.hasOwn(reply, 'result')) throw Error('RPC error');
      return reply.result;
    } catch { throw new LocalDeskError('Invoice status could not be confirmed from the local chain. No payment was requested.'); }
  }
  if ((await rpc('status', {})).chain_id !== target.chainId) throw new LocalDeskError('Local chain identity mismatch.');
  const head = (await rpc('block', {finality: 'final'})).header;
  if (!head || typeof head.hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(head.hash) || !Number.isSafeInteger(head.height) || head.height < 0) {
    throw new LocalDeskError('The local chain returned no finalized block.');
  }
  async function view(method: 'get_payment' | 'get_invoice_auth' | 'get_service_claim' | 'get_vault_controls', args: Record<string, unknown>) {
    const result = await rpc('query', {request_type: 'call_function', block_id: head.hash, account_id: target.vault,
      method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64')});
    if (result.block_hash !== head.hash || !Array.isArray(result.result)) throw new LocalDeskError('The local chain returned an inconsistent invoice snapshot.');
    return JSON.parse(Buffer.from(result.result).toString());
  }
  const [payment, auth, serviceClaim, controls]: [Payment | null, unknown, unknown, any] = await Promise.all([
    view('get_payment', {invoice_id: id}), view('get_invoice_auth', {invoice_id: id}),
    signed.service ? view('get_service_claim', {service: signed.service}) : null,
    view('get_vault_controls', {}),
  ]);
  if (payment !== null && (typeof payment !== 'object' || Array.isArray(payment))) {
    throw new LocalDeskError('The local chain returned an inconsistent invoice receipt.');
  }
  if (payment && (payment.commitment !== expected || commitment(payment.invoice) !== expected || !matchesInvoiceReceipt(signed, auth))) {
    throw new LocalDeskError('The vault record belongs to a different signed bill.');
  }
  if ((!payment && auth !== null) || (payment && (!states.includes(payment.state) ||
      !(payment.attempt_id === null || (typeof payment.attempt_id === 'string' && idPattern.test(payment.attempt_id))) ||
      (['Reserved', 'Executing', 'Settled', 'Failed'].includes(payment.state) && payment.attempt_id === null)))) {
    throw new LocalDeskError('The local chain returned an inconsistent invoice receipt.');
  }
  if (!(serviceClaim === null || (typeof serviceClaim === 'string' && idPattern.test(serviceClaim))) ||
      controls?.owner !== 'owner.test.near' || !validAccount(controls?.executor) || typeof controls?.paused !== 'boolean') {
    throw new LocalDeskError('The local chain returned invalid vault controls or a service claim.');
  }
  // A restart or upgrade during the read must not silently change the source.
  checkTarget(target, false).close();
  return {
    network: 'LOCAL_SANDBOX', vault: target.vault, read_only: true, ...summary(signed, String(row.state)),
    source: {block_hash: head.hash, block_height: head.height, finality: 'final'},
    vault_state: payment?.state ?? null, payment_confirmed: payment?.state === 'Settled',
    receipt: payment ? {state: payment.state, attempt_id: payment.attempt_id, block_hash: head.hash,
      signed_payload_hash: signedInvoiceHash(signed)} : null,
    service_claim: serviceClaim,
    controls: {paused: controls.paused, executor: controls.executor},
    message: payment ? messages[payment.state] : serviceClaim && serviceClaim !== id
      ? `This week is claimed by [${serviceClaim}]. This bill has no finalized payment record.`
      : 'No finalized payment record for this bill. This status is not approval to pay.',
  };
}
