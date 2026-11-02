import {approveDryRoute,type OwnerRouteTransport} from './approval.ts';
import { createHash } from 'node:crypto';
import { SimulationTracker } from './tracker.ts';
import { validateQuote, type Policy } from './quotes.ts';

export class DryRunWorkflow {
 tracker: SimulationTracker;
 constructor(path: string) {
  this.tracker = new SimulationTracker(path);
  this.tracker.db.exec('CREATE TABLE IF NOT EXISTS dry_quotes (id TEXT PRIMARY KEY, policy TEXT NOT NULL, response TEXT NOT NULL, validation TEXT NOT NULL, recorded INTEGER NOT NULL, mode TEXT NOT NULL)');
 }
 save(id: string, policy: Policy, response: unknown, mode: 'LIVE_PREVIEW' | 'ARCHIVED_REPLAY' = 'LIVE_PREVIEW') {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) throw Error('invalid workflow id');
  if (!['LIVE_PREVIEW','ARCHIVED_REPLAY'].includes(mode)) throw Error('invalid mode');
  // Replay validates authenticity at capture time, and is NEVER labelled a fresh quote.
  const time = mode === 'ARCHIVED_REPLAY' ? Date.parse((response as any)?.timestamp) : Date.now();
  const validation = validateQuote(policy,response,time);
  const terms = JSON.stringify([policy.originAsset,policy.destinationAsset,policy.recipient,policy.refundTo,policy.amountOut,policy.maxAmountIn,policy.deadline]);
  const binding = createHash('sha256').update(terms+'\n'+validation.quoteHash).digest('hex');
  const db = this.tracker.db;
  db.exec('BEGIN IMMEDIATE');
  try {
   const prior = db.prepare('SELECT * FROM dry_quotes WHERE id=?').get(id);
   if (prior) {
    if (prior.policy !== terms || JSON.parse(String(prior.validation)).quoteHash !== validation.quoteHash || prior.mode !== mode) throw Error('workflow id already bound to another quote/policy');
   } else {
    db.prepare('INSERT INTO dry_quotes VALUES (?,?,?,?,?,?)').run(id,terms,JSON.stringify(response),JSON.stringify(validation),Date.now(),mode);
    this.tracker.register(id,binding);
   }
   db.exec('COMMIT');
  } catch(e) { db.exec('ROLLBACK');throw e; }
  return this.inspect(id);
 }
 async approve(id:string,owner:OwnerRouteTransport){
  const row=this.tracker.db.prepare('SELECT * FROM dry_quotes WHERE id=?').get(id);
  if(!row||row.mode!=='LIVE_PREVIEW')throw Error('Only a fresh live preview can be approved');
  const [originAsset,destinationAsset,recipient,refundTo,amountOut,maxAmountIn,deadline]=JSON.parse(String(row.policy));
  return approveDryRoute(owner,id,{originAsset,destinationAsset,recipient,refundTo,amountOut,maxAmountIn,deadline},JSON.parse(String(row.response)));
 }
 inspect(id: string) {
  const row = this.tracker.db.prepare('SELECT * FROM dry_quotes WHERE id=?').get(id);
  if (!row) throw Error('unknown workflow');
  const validation = JSON.parse(String(row.validation));
  return { id, mode: row.mode, fundable: false, expired: Date.now() >= validation.expiresAt, validation, simulation: this.tracker.get(id), events: this.tracker.db.prepare('SELECT payload FROM simulation_events WHERE id=? ORDER BY rowid').all(id).map(r=>JSON.parse(String(r.payload))) };
 }
 simulate(id: string, event: {status:string;updatedAt:string}) {
  this.inspect(id);
  if (typeof event.status !== 'string' || event.status.length > 64 || !Number.isFinite(Date.parse(event.updatedAt))) throw Error('invalid simulation event');
  const row = this.tracker.get(id);
  this.tracker.observe(id,{quoteHash:String(row.binding),...event});
  return this.inspect(id);
 }
 close() {this.tracker.close();}
}
