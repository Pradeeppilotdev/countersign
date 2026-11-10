import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {freshPolicySnapshot,renewSavedPolicy} from './policy-renewal.ts';
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'renewal-test-'));
 const state:any={policy:{version:'1',merchants:[{id:'one',payee:'one.near'},{id:'two',payee:'two.near'}],per_payment:'100',daily_limit:'150',expires_at:'1000'},min_payment:'7',usage:'140',now:'2000'};
 const receipts=new Map<string,any>(),calls:any[]=[];let fault='';
 const context={directory,identity:'saved:vault.test.near',freshSnapshot:async()=>structuredClone(state),view:async(method:string,args:any)=>structuredClone(method==='policy_snapshot'?state:receipts.get(args.renewal_id)??null),call:async(method:string,args:any)=>{
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
test('first renewal uses a finalized post-restart clock and pins its deadline on replay',async()=>{
 const f=fixture();try{
  const stale=Number(f.state.now),current=stale+210*60_000;
  const finalHeights=[99,100,101];
  const provider={
   async block({finality}:{finality:string}){
    const height=finality==='optimistic'?100:finalHeights.shift();assert.ok(height);
    return {header:{height,hash:'block-'+height}};
   },
   async viewCall(vault:string,method:string,args:unknown,at:unknown){
    assert.equal(vault,'vault.test.near');assert.equal(method,'policy_snapshot');
    assert.deepEqual(args,{});assert.deepEqual(at,{block_id:'block-101'});f.state.now=String(current);
    return {block_hash:'block-101',result:Buffer.from(JSON.stringify(f.state))};
   },
  };
  f.context.freshSnapshot=()=>freshPolicySnapshot(provider as unknown as Parameters<typeof freshPolicySnapshot>[0],'vault.test.near');
  const result=await renewSavedPolicy(f.context,'first',120);
  assert.equal(result.state,'confirmed');assert.equal(finalHeights.length,0);
  assert.ok(stale+120*60_000<current);
  assert.equal(result.receipt?.expires_at,String(current+120*60_000));
  f.context.freshSnapshot=async()=>{throw Error('Historical receipt must not wait for a new block');};
  assert.deepEqual((await renewSavedPolicy(f.context,'first',120)).receipt,result.receipt);assert.equal(f.calls.length,1);
 }finally{f.close();}
});
test('unavailable fresh time creates no intent and an old pending deadline cannot be rebased',async()=>{
 const f=fixture();try{
  const fresh=f.context.freshSnapshot;
  f.context.freshSnapshot=async()=>{throw Error('No new block');};
  await assert.rejects(()=>renewSavedPolicy(f.context,'same',60),/No new block/);
  assert.equal(existsSync(join(f.context.directory,'policy-renewals','same.json')),false);assert.equal(f.calls.length,0);
  f.context.freshSnapshot=fresh;f.setFault('before');
  await assert.rejects(()=>renewSavedPolicy(f.context,'same',60),/unconfirmed/);
  const original=f.record('same').request;
  f.context.freshSnapshot=async()=>({...f.state,now:original.expires_at});
  assert.equal((await renewSavedPolicy(f.context,'same',60)).state,'expired');
  assert.deepEqual(f.record('same').request,original);assert.equal(f.calls.length,1);
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
test('a receipt that appears during the fresh-block wait resolves the pending request without resubmission',async()=>{
 const f=fixture();try{
  f.setFault('after');
  await assert.rejects(()=>renewSavedPolicy(f.context,'in-flight',60),/unconfirmed/);
  const accepted=f.receipts.get('in-flight');f.receipts.delete('in-flight');
  f.context.freshSnapshot=async()=>{
   f.receipts.set('in-flight',accepted);
   return structuredClone(f.state);
  };
  const done=await renewSavedPolicy(f.context,'in-flight',60);
  assert.equal(done.state,'confirmed');assert.deepEqual(done.receipt,accepted);assert.equal(f.calls.length,1);
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
