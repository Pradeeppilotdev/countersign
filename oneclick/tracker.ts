import { DatabaseSync } from 'node:sqlite';
// Simulation ONLY. No network, vault adapter, wallet or payment submission capability.
export class SimulationTracker {
 db: DatabaseSync;
 constructor(path: string) {
  this.db = new DatabaseSync(path);
  this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS simulations (id TEXT PRIMARY KEY, binding TEXT NOT NULL, state TEXT NOT NULL, updated INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS simulation_events (id TEXT, payload TEXT NOT NULL)");
 }
 register(id: string, quoteHash: string) {
  if (!id || !quoteHash) throw Error('missing binding');
  this.db.prepare("INSERT OR IGNORE INTO simulations VALUES (?, ?, 'SIMULATED_PENDING', 0)").run(id,quoteHash);
  if (this.get(id).binding !== quoteHash) throw Error('conflicting quote');
 }
 get(id: string) { const r = this.db.prepare('SELECT * FROM simulations WHERE id=?').get(id); if (!r) throw Error('unknown simulation'); return r; }
 observe(id: string, event: { quoteHash: string; status: string; updatedAt: string }) {
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const row = this.get(id), t = Date.parse(event.updatedAt);
   if (row.binding !== event.quoteHash || !Number.isFinite(t)) throw Error('invalid observation binding/time');
   this.db.prepare('INSERT INTO simulation_events VALUES (?,?)').run(id,JSON.stringify(event));
   if (t > Number(row.updated)) {
    const mapped: Record<string,string> = { PENDING_DEPOSIT:'SIMULATED_PENDING', KNOWN_DEPOSIT_TX:'SIMULATED_PENDING', INCOMPLETE_DEPOSIT:'NEEDS_REVIEW', PROCESSING:'SIMULATED_PROCESSING', SUCCESS:'SIMULATED_PROVIDER_SUCCESS', REFUNDED:'SIMULATED_PROVIDER_REFUND' };
    let next = mapped[event.status] ?? 'NEEDS_REVIEW';
    // A failure/unknown observation never authorizes retry; conflicts remain held.
    if (row.state === 'NEEDS_REVIEW' || (String(row.state).startsWith('SIMULATED_PROVIDER_') && row.state !== next)) next = 'NEEDS_REVIEW';
    this.db.prepare('UPDATE simulations SET state=?,updated=? WHERE id=?').run(next,t,id);
   }
   this.db.exec('COMMIT'); return this.get(id);
  } catch(e) { this.db.exec('ROLLBACK'); throw e; }
 }
 close() { this.db.close(); }
}
