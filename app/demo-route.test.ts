import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDemoRoute} from './demo-route.ts';
import {DeskWebError} from '../agent/desk-web.ts';
const actions=['state','progress','setup','receive','pay-all','faucet','wallet-faucet','deposit','set-rules','renew-rules','reset'];
const RULES={per_bill:'0.5',daily_budget:'2',hours:'3'};
const bodyFor=(action:string)=>action==='pay-all'?{live:false}:action==='deposit'?{amount:'1'}:action==='set-rules'?RULES:{};
function fixture(network?:string){
 let calls=0;
 const op=async()=>{calls++;return {ready:true};};
 const deposits:bigint[]=[],rules:any[]=[];
 return {route:createDemoRoute({network:()=>network,state:op,setup:op,receive:op,pay:op,faucet:op,walletFaucet:op,deposit:async(amount:bigint)=>{deposits.push(amount);return op();},
  setRules:async(r:any)=>{rules.push(r);return op();},renewRules:op,reset:op,modelReady:()=>false}),calls:()=>calls,deposits,rules};
}
test('all demo routes refuse every non-local selector before invoking operations',async()=>{
 for(const network of ['mainnet','testnet','sandbox','','remote']){
  const f=fixture(network);
  for(const action of actions)assert.equal((await f.route(['state','progress'].includes(action)?'GET':'POST','/api/demo/'+action,bodyFor(action))).status,403);
  assert.equal(f.calls(),0);
 }
});
test('demo mutation bodies and model choice are strictly validated',async()=>{
 const f=fixture('local');
 for(const action of actions.filter(a=>!['state','progress'].includes(a))){
  for(const body of [null,[],true,{unexpected:true}])assert.equal((await f.route('POST','/api/demo/'+action,body)).status,400);
 }
 assert.equal((await f.route('POST','/api/demo/pay-all',{live:true})).status,400);
 assert.equal((await f.route('POST','/api/demo/pay-all',{live:false},16385)).status,413);
 assert.equal(f.calls(),0);
 assert.equal((await f.route('POST','/api/demo/pay-all',{live:false})).status,200);
 assert.equal((await f.route('POST','/api/demo/setup',{})).status,200);
});
test('demo rejects concurrent operations but exposes progress',async()=>{
 let finish!:()=>void;const pending=new Promise<void>(resolve=>finish=resolve);
 const op=async()=>{};
 const route=createDemoRoute({network:()=>undefined,state:op,setup:op,receive:op,pay:async(_,progress)=>{progress.running=true;await pending;},faucet:op,walletFaucet:op,deposit:op,setRules:op,renewRules:op,reset:op,modelReady:()=>false});
 const run=route('POST','/api/demo/pay-all',{live:false});
 assert.equal((await route('POST','/api/demo/reset',{})).status,409);
 assert.equal((await route('POST','/api/demo/wallet-faucet',{})).status,409);
 assert.equal((await route('POST','/api/demo/deposit',{amount:'1'})).status,409);
 assert.equal((await route('POST','/api/demo/set-rules',RULES)).status,409);
 assert.equal((await route('POST','/api/demo/renew-rules',{})).status,409);
 assert.equal((await route('GET','/api/demo/progress',undefined)).body.progress?.running,true);
 finish();await run;
});

test('deposit takes exactly one amount string and passes exact yoctoNEAR; bad amounts never reach the vault',async()=>{
 const f=fixture('local');
 for(const body of [{},{amount:2},{amount:'2',extra:true},{amount:'0'},{amount:'0.0'},{amount:'-1'},{amount:'abc'},{amount:'1.'},{amount:'.5'},{amount:'1e2'},{amount:' 1'},{amount:'1.0000000000000000000000001'}]){
  const reply=await f.route('POST','/api/demo/deposit',body);
  assert.equal(reply.status,400,JSON.stringify(body));
 }
 assert.match((await f.route('POST','/api/demo/deposit',{amount:'0'})).body.error,/greater than 0/);
 assert.equal(f.calls(),0);
 assert.equal((await f.route('POST','/api/demo/deposit',{amount:'2'})).status,200);
 assert.equal((await f.route('POST','/api/demo/deposit',{amount:'0.000000000000000000000001'})).status,200);
 assert.equal((await f.route('POST','/api/demo/deposit',{amount:'123.456'})).status,200);
 assert.deepEqual(f.deposits,[2n*10n**24n,1n,123456n*10n**21n]);
 assert.equal((await f.route('POST','/api/demo/wallet-faucet',{})).status,200);
 assert.equal((await f.route('POST','/api/demo/wallet-faucet',{amount:'5'})).status,400);
});
test('a deposit over the wallet minus the gas reserve comes back as a 400 with the reason',async()=>{
 const op=async()=>({ready:true});
 const route=createDemoRoute({network:()=>'local',state:op,setup:op,receive:op,pay:op,faucet:op,walletFaucet:op,setRules:op,renewRules:op,
  deposit:async()=>{throw new DeskWebError('You can deposit up to 4.5 NEAR. Keep 0.5 NEAR in your wallet for fees.');},reset:op,modelReady:()=>false});
 const reply=await route('POST','/api/demo/deposit',{amount:'5'});
 assert.equal(reply.status,400);
 assert.equal(reply.body.error,'You can deposit up to 4.5 NEAR. Keep 0.5 NEAR in your wallet for fees.');
});

test('set-rules takes three strings, checks them exactly, and passes yoctoNEAR and hours',async()=>{
 const f=fixture('local');
 const cases:[any,RegExp][]=[
  [{per_bill:'3',daily_budget:'2',hours:'3'},/can't be more than the daily budget/],
  [{per_bill:'0',daily_budget:'2',hours:'3'},/Most per bill: enter an amount greater than 0/],
  [{per_bill:'0.5',daily_budget:'0.000',hours:'3'},/Daily budget: enter an amount greater than 0/],
  [{per_bill:'-1',daily_budget:'2',hours:'3'},/Most per bill: enter an amount/],
  [{per_bill:'0.5',daily_budget:'abc',hours:'3'},/Daily budget: enter an amount/],
  [{per_bill:'0.5',daily_budget:'6',hours:'3'},/at most 5 NEAR/],
  [{per_bill:'0.5',daily_budget:'2',hours:'0'},/from 1 to 24 hours/],
  [{per_bill:'0.5',daily_budget:'2',hours:'25'},/from 1 to 24 hours/],
  [{per_bill:'0.5',daily_budget:'2',hours:'1.5'},/from 1 to 24 hours/],
  [{per_bill:'0.5',daily_budget:'2',hours:'-2'},/from 1 to 24 hours/],
 ];
 for(const [body,message] of cases){
  const reply=await f.route('POST','/api/demo/set-rules',body);
  assert.equal(reply.status,400,JSON.stringify(body));assert.match(reply.body.error,message);
 }
 for(const body of [{},{per_bill:'0.5',daily_budget:'2'},{per_bill:0.5,daily_budget:'2',hours:'3'},{...RULES,extra:'1'},{per_bill:'0.5',daily_budget:'2',hours:3}])
  assert.equal((await f.route('POST','/api/demo/set-rules',body)).status,400,JSON.stringify(body));
 assert.equal((await f.route('POST','/api/demo/renew-rules',{hours:'2'})).status,400);
 assert.equal(f.calls(),0);
 assert.equal((await f.route('POST','/api/demo/set-rules',RULES)).status,200);
 assert.equal((await f.route('POST','/api/demo/set-rules',{per_bill:'0.000000000000000000000001',daily_budget:'5',hours:'24'})).status,200);
 assert.deepEqual(f.rules,[{per:5n*10n**23n,daily:2n*10n**24n,hours:3},{per:1n,daily:5n*10n**24n,hours:24}]);
 assert.equal((await f.route('POST','/api/demo/renew-rules',{})).status,200);
});
