import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {renewSavedPolicy} from './policy-renewal.ts';
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'renewal-test-'));
 const state:any={policy:{version:'1',merchants:[{id:'one',payee:'one.near'},{id:'two',payee:'two.near'}],per_payment:'100',daily_limit:'150',expires_at:'1000'},min_payment:'7',usage:'140',now:'2000'};
 const receipts=new Map<string,any>(),calls:any[]=[];let fault='';
 const context={directory,identity:'saved:vault.test.near',view:async(method:string,args:any)=>structuredClone(method==='policy_snapshot'?state:receipts.get(args.renewal_id)??null),call:async(method:string,args:any)=>{
  calls.push(structuredClone(args));assert.equal(method,'renew_policy');
  if(fault==='before')throw Error('Connection lost before submission');
  assert.equal(args.expected_version,state.policy.version);state.policy={...state.policy,version:String(BigInt(state.policy.version)+1n),expires_at:args.expires_at};
  receipts.set(args.renewal_id,{renewal_id:args.renewal_id,previous_version:args.expected_version,version:state.policy.version,expires_at:args.expires_at});
  if(fault==='after')throw Error('Response lost after renewal');return state.policy;
 }};
 return {context,state,receipts,calls,setFault:(v:string)=>fault=v,record:(id:string)=>JSON.parse(readFileSync(join(directory,'policy-renewals',id+'.json'),'utf8')),close:()=>rmSync(directory,{recursive:true,force:true})};
}
test('renewal lost response reconciles its receipt without extending expiry or resetting usage',async()=>{
 const f=fixture();try{
  const original=structuredClone(f.state);f.setFault('after');
  await assert.rejects(()=>renewSavedPolicy(f.context,'once',60),/Renewal outcome is unconfirmed.*renew-policy 60 once/);assert.equal(f.record('once').state,'pending');
  const expiry=f.state.policy.expires_at;f.state.now='5000';f.setFault('');
  const done=await renewSavedPolicy(f.context,'once',60);assert.equal(done.state,'confirmed');assert.equal(f.calls.length,1);assert.equal(done.policy!.expires_at,expiry);assert.equal(done.usage,'140');assert.equal(done.min_payment,'7');assert.deepEqual(done.policy!.merchants,original.policy.merchants);
  f.state.now=String(BigInt(expiry)+1n);assert.equal((await renewSavedPolicy(f.context,'once',60)).policy_active,false);assert.equal(f.calls.length,1);
  await assert.rejects(()=>renewSavedPolicy(f.context,'once',120),/does not match/);assert.equal(f.calls.length,1);
 }finally{f.close();}
});
test('unsubmitted renewal retries the fixed intent and rejects another pending request',async()=>{
 const f=fixture();try{
  f.setFault('before');await assert.rejects(()=>renewSavedPolicy(f.context,'retry',60),/Renewal outcome is unconfirmed.*renew-policy 60 retry/);
  await assert.rejects(()=>renewSavedPolicy(f.context,'different',60),/already pending/);
  const request=f.record('retry').request;f.state.now='5000';f.setFault('');
  assert.equal((await renewSavedPolicy(f.context,'retry',60)).state,'confirmed');assert.deepEqual(f.calls,[request,request]);
 }finally{f.close();}
});
test('expired or superseded pending renewals cannot manufacture fresh authority',async()=>{
 for(const change of ['expired','superseded']){
  const f=fixture();try{
   f.setFault('before');await assert.rejects(()=>renewSavedPolicy(f.context,'old',60));
   if(change==='expired')f.state.now=f.record('old').request.expires_at;else f.state.policy=null;
   f.setFault('');assert.equal((await renewSavedPolicy(f.context,'old',60)).state,change);assert.equal(f.calls.length,1);
   assert.equal((await renewSavedPolicy(f.context,'old',60)).state,change);assert.equal(f.calls.length,1);
  }finally{f.close();}
 }
});
test('confirmed receipts remain historical after rule changes and cannot be rebound after journal loss',async()=>{
 const f=fixture();try{
  await renewSavedPolicy(f.context,'historical',60);f.state.policy={...f.state.policy,version:'3',daily_limit:'120'};
  assert.equal((await renewSavedPolicy(f.context,'historical',60)).state,'superseded');assert.equal(f.state.policy.daily_limit,'120');assert.equal(f.calls.length,1);
  await assert.rejects(()=>renewSavedPolicy({...f.context,identity:'other:vault'},'historical',60),/does not match/);
  rmSync(join(f.context.directory,'policy-renewals','historical.json'));
  await assert.rejects(()=>renewSavedPolicy(f.context,'historical',60),/already exists on chain/);assert.equal(f.calls.length,1);
 }finally{f.close();}
});
