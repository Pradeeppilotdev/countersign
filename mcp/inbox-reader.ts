// Public local identity and read-only inbox access. No key store or signer.
import {existsSync, readFileSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {formatNear} from '../agent/ask/facts.ts';
import {requireUpgradeVerified} from '../app/upgrade-state.ts';
import {commitment} from '../executor/core.ts';
import {parseSignedInvoice, type SignedInvoice} from '../merchant/invoice.ts';

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
export type Target = ReturnType<typeof readTarget>;

export function checkTarget(target: Target, requireExecutor = true) {
  const current = readTarget(target.directory);
  if (current.identity !== target.identity || current.chainId !== target.chainId || current.rpc !== target.rpc || (requireExecutor && current.executor !== target.executor)) {
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

export function summary(signed: SignedInvoice, state: string) {
  return {invoice_id: signed.invoice.id, bill_id: signed.bill_id, merchant_id: signed.merchant_id,
    payee: signed.invoice.payee, amount_near: formatNear(signed.invoice.amount),
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
