import {prepareRoute,routeCommitment,type OwnerRouteTransport} from './approval.ts';
import { createHash } from 'node:crypto';
import { SimulationTracker } from './tracker.ts';
import { validateQuote, type Policy } from './quotes.ts';

export class DryRunWorkflow {
 tracker: SimulationTracker;
 constructor(path: string) {
  this.tracker = new SimulationTracker(path);
  this.tracker.db.exec("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS dry_approvals (id TEXT PRIMARY KEY, vault TEXT NOT NULL, route TEXT NOT NULL, commitment TEXT NOT NULL, state TEXT NOT NULL)");
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
 // Persist the immutable attempt BEFORE any owner call. A second process or a
 // restarted app only reads the chain, even if the first call never reached it.
 async approve(id:string,owner:OwnerRouteTransport){
  if(this.approvalRecord(id))return this.reconcileApproval(id,owner);
  const row=this.tracker.db.prepare('SELECT * FROM dry_quotes WHERE id=?').get(id);
  if(!row||row.mode!=='LIVE_PREVIEW')throw Error('Only a fresh live preview can be approved');
  const [originAsset,destinationAsset,recipient,refundTo,amountOut,maxAmountIn,deadline]=JSON.parse(String(row.policy));
  const route=prepareRoute(id,{originAsset,destinationAsset,recipient,refundTo,amountOut,maxAmountIn,deadline},JSON.parse(String(row.response)));
  const commitment=routeCommitment(owner.vault,route);
  const inserted=this.tracker.db.prepare("INSERT OR IGNORE INTO dry_approvals VALUES (?,?,?,?, 'SUBMITTING')").run(id,owner.vault,JSON.stringify(route),commitment);
  if(inserted.changes===0)return this.reconcileApproval(id,owner);
  try{
   await owner.call('authorize_route',{route});
  }catch{
   // RPC errors do not prove rejection. Do not retry or expose provider text.
   this.tracker.db.prepare("UPDATE dry_approvals SET state='UNKNOWN' WHERE id=? AND state='SUBMITTING'").run(id);
  }
  return this.reconcileApproval(id,owner);
 }
 private approvalRecord(id:string){return this.tracker.db.prepare('SELECT * FROM dry_approvals WHERE id=?').get(id);}
 // Read-only recovery works after quote expiry: get_route proves the historical
 // binding, whereas check_route deliberately rejects expired authorizations.
 async reconcileApproval(id:string,owner:Pick<OwnerRouteTransport,'vault'|'view'>){
  const row=this.approvalRecord(id);
  if(!row)throw Error('No recorded approval attempt');
  if(row.vault!==owner.vault)throw Error('Approval attempt is bound to another vault');
  if(row.state==='NEEDS_REVIEW')return this.approvalSnapshot(id);
  let approved:any;
  try{approved=await owner.view('get_route',{invoice_id:id});}
  catch{return this.approvalSnapshot(id);}
  if(approved==null)return this.approvalSnapshot(id);
  let matches=false;
  try{matches=approved.commitment===row.commitment && routeCommitment(owner.vault,approved.route)===row.commitment;}catch{}
  // A conflicting observation creates a sticky hold. A late successful read
  // cannot overwrite it when two processes reconcile concurrently.
  this.tracker.db.prepare("UPDATE dry_approvals SET state=? WHERE id=? AND state!='NEEDS_REVIEW'").run(matches?'APPROVED':'NEEDS_REVIEW',id);
  return this.approvalSnapshot(id);
 }
 private approvalSnapshot(id:string){
  const row=this.approvalRecord(id)!;
  const route=JSON.parse(String(row.route));
  return {mode:'DRY_RUN',fundable:false,approvalState:row.state==='SUBMITTING'?'UNKNOWN':row.state,expired:Date.now()>=Number(route.expires_at),approval:row.state==='APPROVED'?{route,commitment:String(row.commitment)}:null};
 }
 inspect(id: string) {
  const row = this.tracker.db.prepare('SELECT * FROM dry_quotes WHERE id=?').get(id);
  if (!row) throw Error('unknown workflow');
  const validation = JSON.parse(String(row.validation));
  return { id, mode: row.mode, fundable: false, expired: Date.now() >= validation.expiresAt, validation, approval: this.approvalRecord(id)?this.approvalSnapshot(id):null, simulation: this.tracker.get(id), events: this.tracker.db.prepare('SELECT payload FROM simulation_events WHERE id=? ORDER BY rowid').all(id).map(r=>JSON.parse(String(r.payload))) };
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
