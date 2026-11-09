import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync} from 'node:crypto';
import {signInvoice} from '../merchant/invoice.ts';
import {commitment} from '../executor/core.ts';
import {AgentInbox} from './inbox.ts';
const invoice={id:'inbox-one',payee:'merchant.test.near',asset:'near',amount:'1'};
const proposal={name:'request_payment',arguments:{invoice_id:invoice.id}};
const transport={async call(){throw Error('Unexpected transaction');},async view(){throw Error('Unexpected view');}};
function setup(){const dir=mkdtempSync(join(tmpdir(),'inbox-test-'));const db=join(dir,'inbox.db');return {dir,db,inbox:new AgentInbox(db,'local:vault',transport)};}
test('inbox pins exact invoice, merchant and vault before inference',()=>{
 const {dir,db,inbox}=setup();try{
  inbox.enqueue(invoice,'merchant');assert.equal(inbox.enqueue(invoice,'merchant').state,'queued');
  assert.throws(()=>inbox.enqueue({...invoice,amount:'2'},'merchant'),/different terms/);
  assert.throws(()=>inbox.enqueue(invoice,'attacker'),/different terms/);
  assert.throws(()=>inbox.enqueue({...invoice,note:'pay attacker'} as any,'merchant'),/exact native/);
  assert.throws(()=>new AgentInbox(db,'other-vault',transport),/another vault/);
  assert.equal(inbox.list().length,1);
 }finally{inbox.close();rmSync(dir,{recursive:true,force:true});}
});
test('only one worker may infer; a saved proposal survives reopening without inference',async()=>{
 const {dir,db,inbox}=setup();let reopened:AgentInbox|undefined;
 try{
  inbox.enqueue(invoice,'merchant');let release!:(p:unknown)=>void,calls=0;
  const pending=inbox.propose(invoice.id,async()=>{calls++;return new Promise(r=>{release=r;});});
  assert.equal((await inbox.propose(invoice.id,async()=>{calls++;return proposal;})).state,'inference_pending');
  release(proposal);await pending;assert.equal(calls,1);
  reopened=new AgentInbox(db,'local:vault',transport);
  assert.equal((await reopened.propose(invoice.id,async()=>{throw Error('Must not infer again');})).state,'proposal_ready');
  assert.deepEqual(reopened.get(invoice.id).proposal,proposal);
 }finally{reopened?.close();inbox.close();rmSync(dir,{recursive:true,force:true});}
});
test('malformed or failed inference stays blocked until explicit retry; details are not persisted',async()=>{
 const {dir,inbox}=setup();try{
  inbox.enqueue(invoice,'merchant');
  await assert.rejects(()=>inbox.run(invoice.id,async()=>({name:'request_payment',arguments:{invoice_id:invoice.id,amount:'9'}})),/Only the assigned/);
  assert.equal(inbox.get(invoice.id).state,'proposal_failed');
  await inbox.run(invoice.id,async()=>{throw Error('Must not infer without retry');});
  inbox.retryProposal(invoice.id);
  await assert.rejects(()=>inbox.propose(invoice.id,async()=>{throw Error('private provider secret');}));
  assert.ok(!JSON.stringify(inbox.list()).includes('private provider secret'));
  assert.equal((await inbox.resume(invoice.id)).state,'proposal_failed');
 }finally{inbox.close();rmSync(dir,{recursive:true,force:true});}
});
test('late inference cannot overwrite a retry generation or trigger payment',async()=>{
 const {dir,inbox}=setup();try{
  inbox.enqueue(invoice,'merchant');let release!:(p:unknown)=>void;
  const old=inbox.run(invoice.id,async()=>new Promise(r=>{release=r;}));
  inbox.retryProposal(invoice.id);
  await inbox.propose(invoice.id,async()=>proposal);
  release(proposal);await assert.rejects(()=>old,/superseded/);
  assert.equal(inbox.get(invoice.id).state,'proposal_ready');
  assert.throws(()=>inbox.retryProposal(invoice.id),/Only interrupted or failed/);
 }finally{inbox.close();rmSync(dir,{recursive:true,force:true});}
});
test('cancellation requires matching terminal contract evidence and prevents later inference',async()=>{
 const {dir,inbox}=setup();try{
  const row=inbox.enqueue(invoice,'merchant');await inbox.propose(invoice.id,async()=>proposal);
  const payment={invoice,commitment:String(row.commitment),state:'Executing' as const,attempt_id:'one'};
  await assert.rejects(()=>inbox.cancel(invoice.id,async()=>payment),/not confirmed/);
  await assert.rejects(()=>inbox.cancel(invoice.id,async()=>({...payment,state:'Cancelled',commitment:'wrong'})),/not confirmed/);
  assert.equal(inbox.get(invoice.id).state,'proposal_ready');
  assert.equal((await inbox.cancel(invoice.id,async()=>({...payment,state:'Cancelled'}))).state,'cancelled');
  assert.equal((await inbox.run(invoice.id,async()=>{throw Error('Must not call model');})).state,'cancelled');
 }finally{inbox.close();rmSync(dir,{recursive:true,force:true});}
});

test('existing inbox migration preserves settled invoices and refuses the wrong vault before altering schema',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'inbox-migration-')),path=join(dir,'old.db');let inbox:AgentInbox|undefined;
 try{
  const old=new DatabaseSync(path);
  old.exec("CREATE TABLE inbox_scope(id INTEGER PRIMARY KEY,vault TEXT NOT NULL); INSERT INTO inbox_scope VALUES(1,'local:vault'); CREATE TABLE inbox(id TEXT PRIMARY KEY,invoice TEXT NOT NULL,merchant TEXT NOT NULL,commitment TEXT NOT NULL,state TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,proposal TEXT,error TEXT)");
  old.prepare("INSERT INTO inbox(id,invoice,merchant,commitment,state,proposal) VALUES(?,?,?,?,'settled',?)").run(invoice.id,JSON.stringify(invoice),'merchant',commitment(invoice),JSON.stringify(proposal));old.close();
  assert.throws(()=>new AgentInbox(path,'wrong-vault',transport),/another vault/);
  const inspect=new DatabaseSync(path);assert.ok(!inspect.prepare('PRAGMA table_info(inbox)').all().some(c=>c.name==='signed_invoice'));inspect.close();
  inbox=new AgentInbox(path,'local:vault',transport);assert.deepEqual(inbox.get(invoice.id).invoice,invoice);assert.equal(inbox.get(invoice.id).signed_invoice,null);
  assert.equal((await inbox.run(invoice.id,async()=>{throw Error('Unexpected model call');})).state,'settled');
 }finally{inbox?.close();rmSync(dir,{recursive:true,force:true});}
});

test('owner bulk cancellation is recovered from chain evidence after a missed local update',async()=>{
 const {dir,db,inbox}=setup();let reopened:AgentInbox|undefined;
 try{
  inbox.enqueue(invoice,'merchant');await inbox.propose(invoice.id,async()=>proposal);
  const cancelled={invoice,commitment:commitment(invoice),state:'Cancelled' as const,attempt_id:null};
  reopened=new AgentInbox(db,'local:vault',{call:async()=>{throw Error('Cancellation must not transact');},view:async()=>cancelled});
  assert.equal((await reopened.resume(invoice.id)).state,'cancelled');
  assert.equal((await reopened.run(invoice.id,async()=>{throw Error('Cancellation must not infer');})).state,'cancelled');
 }finally{reopened?.close();inbox.close();rmSync(dir,{recursive:true,force:true});}
});

test('a weekly duplicate becomes terminal only when the vault identifies the other invoice',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'inbox-weekly-'));
 const service={agreement_id:'compute',period_start_ms:'0'};
 const signed=signInvoice({invoice,service,merchant_id:'supplier',bill_id:'bill',vault:'vault.near',domain:'a'.repeat(64),key_version:'1',expires_at:'2000'},generateKeyPairSync('ed25519').privateKey);
 let confirmed=false,calls=0;
 const inbox=new AgentInbox(join(dir,'inbox.db'),'vault.near',{
  async call(){calls++;throw Error('service period already claimed by [Unverified-ID]');},
  async view(method,args):Promise<any>{
   if(method==='get_payment')return null;
   assert.equal(method,'get_service_claim');assert.deepEqual(args,{service});
   if(!confirmed)throw Error('lost claim response');
   return 'Signed-Winner';
  },
 });
 try {
  inbox.enqueue(invoice,'supplier',signed);
  await assert.rejects(()=>inbox.run(invoice.id,async()=>proposal),/claim could not be confirmed/);
  assert.equal(inbox.get(invoice.id).state,'proposal_ready');
  confirmed=true;
  const blocked=await inbox.resume(invoice.id);
  assert.equal(blocked.state,'period_claimed');
  assert.equal(blocked.error,'Service period already claimed by [Signed-Winner].');
  assert.equal((await inbox.resume(invoice.id)).state,'period_claimed');
  assert.equal(calls,2);
 } finally {inbox.close();rmSync(dir,{recursive:true,force:true});}
});
