import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createAgentRoute} from './agent-route.ts';

function fixture(overrides={}){
 const calls:any[]=[];
 const deps={state:async()=>({bills:[]}),importBill:async(invoice:unknown)=>{calls.push(['import',invoice]);return {record:{id:'A'}};},
  run:async(id:string,live:boolean)=>{calls.push(['run',id,live]);return {record:{id,state:'settled'}};},
  resume:async(id:string)=>{calls.push(['resume',id]);return {record:{id,state:'proposal_ready'}};},
  modelReady:()=>false,error:(e:unknown)=>(e as Error).message,...overrides};
 return {calls,handle:createAgentRoute(deps)};
}
test('agent routes reject bad bodies, unknown actions and wrong methods',async()=>{
 const {handle,calls}=fixture();
 for(const input of [null,[],1,'bill',{}, {invoice:null},{invoice:[]},{invoice:{},extra:1}])assert.equal((await handle('POST','/api/agent/import',input)).status,400);
 for(const input of [{id:'A'}, {id:'bad id',live:false}, {id:'A',live:'yes'}, {id:'A',live:false,amount:1}, {id:'x'.repeat(129),live:false}])assert.equal((await handle('POST','/api/agent/run',input)).status,400);
 assert.equal((await handle('POST','/api/agent/resume',{id:'A',live:true})).status,400);
 assert.equal((await handle('GET','/api/agent/run',{})).status,405);
 assert.equal((await handle('POST','/api/agent/state',{})).status,405);
 assert.equal((await handle('POST','/api/agent/pay',{})).status,404);
 assert.equal(calls.length,0);
});
test('agent body size is bounded before dispatch',async()=>{
 const {handle,calls}=fixture();
 assert.equal((await handle('POST','/api/agent/import',{invoice:{}},16385)).status,413);
 assert.equal((await handle('POST','/api/agent/import',{invoice:{}},16384)).status,200);
 assert.equal(calls.length,1);
});
test('live requests need configured credentials; fixture and resume never check a model',async()=>{
 const {handle,calls}=fixture();
 const r=await handle('POST','/api/agent/run',{id:'A',live:true});
 assert.deepEqual(r,{status:400,body:{ok:false,error:'No model key configured'}});
 await handle('POST','/api/agent/run',{id:'A',live:false});await handle('POST','/api/agent/resume',{id:'A'});
 assert.deepEqual(calls,[['run','A',false],['resume','A']]);
 const ready=fixture({modelReady:()=>true});await ready.handle('POST','/api/agent/run',{id:'A',live:true});assert.deepEqual(ready.calls,[['run','A',true]]);
});
test('only one run or resume is in flight and the gate releases after failure',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const {handle}=fixture({run:async()=>{await gate;throw Error('Rejected');}});
 const first=handle('POST','/api/agent/run',{id:'A',live:false});
 assert.equal((await handle('POST','/api/agent/run',{id:'B',live:false})).status,409);
 assert.equal((await handle('POST','/api/agent/resume',{id:'A'})).status,409);
 assert.equal((await handle('GET','/api/agent/state',undefined)).status,200);
 release();assert.equal((await first).status,400);
 assert.equal((await handle('POST','/api/agent/resume',{id:'A'})).status,200);
});
test('no vault, locked vault and import rejection have clear responses',async()=>{
 for(const [message,status] of [['No agent vault yet. Run npm run agent:desk -- init first.',200],['Agent vault is in use by another process',409],['Invalid merchant signature',400]] as const){
  const fail=async()=>{throw Error(message);};const {handle}=fixture({state:fail,importBill:fail});
  const r=await handle('POST','/api/agent/import',{invoice:{}});assert.deepEqual(r,{status,body:{ok:false,error:message}});
  assert.equal((await handle('GET','/api/agent/state',undefined)).body.error,message);
 }
});
test('identical imports preserve the existing record and expose Already imported metadata',async()=>{
 const record={id:'A',state:'settled'};const {handle}=fixture({importBill:async()=>({already_imported:true,record})});
 assert.deepEqual((await handle('POST','/api/agent/import',{invoice:{}})).body,{ok:true,already_imported:true,record});
});
test('agent route loads no signing, SDK, payment or dynamic modules; UI renders text safely',()=>{
 const route=readFileSync(new URL('agent-route.ts',import.meta.url),'utf8').replace(/\/\/.*$/gm,'');
 assert.equal(/^\s*import(?:\s|\()|\bimport\s*\(|\brequire\s*\(|createRequire/m.test(route),false);
 const ui=readFileSync(new URL('public/agent-payments.js',import.meta.url),'utf8');
 assert.doesNotMatch(ui,/innerHTML|outerHTML|insertAdjacentHTML|eval\(/);
 const html=readFileSync(new URL('public/index.html',import.meta.url),'utf8');
 assert.ok(html.indexOf('data-view="agent-payments"')<html.indexOf('data-view="ask-dave"'));
 const server=readFileSync(new URL('server.ts',import.meta.url),'utf8');
 const guard=server.indexOf("if(req.method!=='POST'");
 const post=server.indexOf("if(url.pathname.startsWith('/api/agent/'))",guard);
 assert.ok(post>server.indexOf('const input=JSON.parse(body)',guard));
 assert.match(server.slice(guard,post),/Buffer.byteLength\(body\)>16384/);
});
