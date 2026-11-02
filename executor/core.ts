import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type Invoice = { id: string; payee: string; asset: string; amount: string };
export type Payment = { invoice: Invoice; commitment: string; state: 'Authorized' | 'Reserved' | 'Executing' | 'Settled' | 'Failed'; attempt_id: string | null };
export interface Authorization { reserve(invoice: Invoice, attempt: string): Promise<Payment>; resolve(id: string, attempt: string, settled: boolean): Promise<Payment> }
export interface Rail { submit(invoice: Invoice, attempt: string): Promise<void>; status(attempt: string): Promise<'settled' | 'failed' | 'unknown'> }
export function commitment(i: Invoice): string {
  if (![i.id, i.asset].every(x => /^[a-zA-Z0-9_.:-]{1,128}$/.test(x)) || !/^[1-9][0-9]*$/.test(i.amount) || BigInt(i.amount) > (1n << 128n) - 1n) throw new Error('invalid invoice');
  const fields = [i.id, i.payee, i.asset, i.amount];
  return createHash('sha256').update('NEAR-AEGIS-INVOICE-V1\n' + fields.map(s => `${Buffer.byteLength(s)}:${s}`).join('')).digest('hex');
}
export class Executor {
  db: DatabaseSync;
  private auth: Authorization;
  private rail: Rail;
  constructor(path: string, auth: Authorization, rail: Rail) {
    this.auth = auth; this.rail = rail;
    this.db = new DatabaseSync(path); this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS attempts (invoice_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, commitment TEXT NOT NULL, state TEXT NOT NULL)');
  }
  close() { this.db.close(); }
  async execute(invoice: Invoice, attempt: string): Promise<string> {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(attempt)) throw new Error('invalid attempt');
    const hash = commitment(invoice);
    // A unique durable claim precedes all external calls. No existing claim is submitted twice.
    const claim = this.db.prepare('INSERT OR IGNORE INTO attempts VALUES (?, ?, ?, ?)').run(invoice.id, attempt, hash, 'claimed');
    if (!claim.changes) {
      const row = this.db.prepare('SELECT * FROM attempts WHERE invoice_id = ?').get(invoice.id);
      if (!row || row.attempt_id !== attempt || row.commitment !== hash) throw new Error('conflicting attempt or invoice');
      return String(row.state);
    }
    // Any error or crash after the claim leaves a manual/reconciliation-only record.
    const p = await this.auth.reserve(invoice, attempt);
    if (p.commitment !== hash || p.state !== 'Reserved' || p.attempt_id !== attempt) throw new Error('reservation not usable');
    this.db.prepare('UPDATE attempts SET state = ? WHERE invoice_id = ?').run('unknown', invoice.id);
    try { await this.rail.submit(invoice, attempt); } catch { /* submission may have succeeded */ }
    return this.reconcile(invoice.id);
  }
  async reconcile(id: string): Promise<string> {
    const row = this.db.prepare('SELECT * FROM attempts WHERE invoice_id = ?').get(id);
    if (!row) throw new Error('unknown attempt');
    if (row.state === 'settled' || row.state === 'failed') return String(row.state);
    // claimed can mean a crash before or after reservation; never assume funds were not sent.
    const status = await this.rail.status(String(row.attempt_id));
    if (status === 'unknown') return String(row.state);
    const p = await this.auth.resolve(id, String(row.attempt_id), status === 'settled');
    if (p.state !== (status === 'settled' ? 'Settled' : 'Failed')) throw new Error('resolution mismatch');
    this.db.prepare('UPDATE attempts SET state = ? WHERE invoice_id = ?').run(status, id);
    return status;
  }
}
