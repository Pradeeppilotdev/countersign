import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DryRunWorkflow} from './workflow.ts';
import {routeCommitment} from './approval.ts';
const policy=JSON.parse(readFileSync(new URL('./fixtures/live-policy.json',import.meta.url),'utf8'));
const quote=JSON.parse(readFileSync(new URL('./fixtures/live-dry-quote.json',import.meta.url),'utf8'));
const captured=Date.parse(quote.timestamp);
const vault='vault.test.near';
// Historical signed fixtures are made fresh ONLY by the test's mock clock.
// No production validation bypass or synthetic signature is used.
function setup(t:any){
 t.mock.method(Date,'now',()=>captured);
 const dir=mkdtempSync(join(tmpdir(),'countersign-approval-'));
 const path=join(dir,'approvals.db');
 const w=new DryRunWorkflow(path);w.save('invoice-1',policy,quote);
 t.after(()=>{if(w.tracker.db.isOpen)w.close();rmSync(dir,{recursive:true,force:true});});
 return {w,path};
}
test('lost response and restart recover an expired approval without a second owner call',async t=>{
 const {w,path}=setup(t);let calls=0,chain:any;
 const transport={vault,async call(method:string,args:any){calls++;assert.equal(method,'authorize_route');chain={route:args.route,commitment:routeCommitment(vault,args.route)};throw Error('response lost');},async view(){throw Error('RPC unavailable');}};
 const uncertain=await w.approve('invoice-1',transport);
 assert.equal(uncertain.approvalState,'UNKNOWN');assert.equal(uncertain.approval,null);
 w.close();const reopened=new DryRunWorkflow(path);
 try{
  t.mock.method(Date,'now',()=>captured+120_000);
  const recovered=await reopened.reconcileApproval('invoice-1',{vault,async view(method,args){assert.equal(method,'get_route');assert.deepEqual(args,{invoice_id:'invoice-1'});return chain;}});
  assert.equal(recovered.approvalState,'APPROVED');assert.equal(recovered.expired,true);assert.equal(recovered.fundable,false);
  assert.deepEqual(recovered.approval,chain);
  const replay=await reopened.approve('invoice-1',{...transport,async view(){return chain;}});
  assert.equal(replay.approvalState,'APPROVED');assert.equal(calls,1);
  await assert.rejects(()=>reopened.approve('invoice-1',{...transport,vault:'other.test.near'}),/another vault/);
 }finally{reopened.close();}
});
test('concurrent processes reserve a single approval attempt; missing chain record never permits retry',async t=>{
 const {w,path}=setup(t);const second=new DryRunWorkflow(path);let calls=0,release!:()=>void;
 const pending=new Promise<void>(resolve=>release=resolve);
 const transport={vault,async call(){calls++;await pending;throw Error('submission outcome unknown');},async view(){return null;}};
 try{
  const first=w.approve('invoice-1',transport);
  const duplicate=await second.approve('invoice-1',transport);
  assert.equal(calls,1);assert.equal(duplicate.approvalState,'UNKNOWN');
  release();assert.equal((await first).approvalState,'UNKNOWN');
  assert.equal((await second.approve('invoice-1',transport)).approvalState,'UNKNOWN');
  assert.equal(calls,1);
 }finally{release();second.close();}
});
test('mismatched route creates a persistent review hold that later success cannot clear',async t=>{
 const {w,path}=setup(t);let calls=0,correct:any;
 const transport={vault,async call(_method:string,args:any){calls++;correct={route:args.route,commitment:routeCommitment(vault,args.route)};},async view(){return {...correct,route:{...correct.route,recipient:'attacker'}};}};
 assert.equal((await w.approve('invoice-1',transport)).approvalState,'NEEDS_REVIEW');
 const reopened=new DryRunWorkflow(path);
 try{
  const held=await reopened.approve('invoice-1',{...transport,async view(){return correct;}});
  assert.equal(held.approvalState,'NEEDS_REVIEW');assert.equal(held.approval,null);assert.equal(calls,1);
 }finally{reopened.close();}
});
test('expired and archived quotes cannot create approval attempts',async t=>{
 const {w}=setup(t);let calls=0;
 const transport={vault,async call(){calls++;},async view(){return null;}};
 w.save('archived',policy,quote,'ARCHIVED_REPLAY');
 await assert.rejects(()=>w.approve('archived',transport),/fresh live preview/);
 t.mock.method(Date,'now',()=>captured+120_000);
 await assert.rejects(()=>w.approve('invoice-1',transport),/stale/);
 assert.equal(w.inspect('invoice-1').approval,null);assert.equal(calls,0);
});
