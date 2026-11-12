import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDemoRoute} from './demo-route.ts';
const actions=['state','progress','setup','receive','pay-all','faucet','reset'];
function fixture(network?:string){
 let calls=0;
 const op=async()=>{calls++;return {ready:true};};
 return {route:createDemoRoute({network:()=>network,state:op,setup:op,receive:op,pay:op,faucet:op,reset:op,modelReady:()=>false}),calls:()=>calls};
}
test('all demo routes refuse every non-local selector before invoking operations',async()=>{
 for(const network of ['mainnet','testnet','sandbox','','remote']){
  const f=fixture(network);
  for(const action of actions)assert.equal((await f.route(['state','progress'].includes(action)?'GET':'POST','/api/demo/'+action,action==='pay-all'?{live:false}:{})).status,403);
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
 const route=createDemoRoute({network:()=>undefined,state:op,setup:op,receive:op,pay:async(_,progress)=>{progress.running=true;await pending;},faucet:op,reset:op,modelReady:()=>false});
 const run=route('POST','/api/demo/pay-all',{live:false});
 assert.equal((await route('POST','/api/demo/reset',{})).status,409);
 assert.equal((await route('GET','/api/demo/progress',undefined)).body.progress?.running,true);
 finish();await run;
});
