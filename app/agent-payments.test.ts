import {test} from 'node:test';
import assert from 'node:assert/strict';

// Exercise the actual browser module and its shared components with a tiny DOM
// and fake HTTP responses. No chain, model, credentials or payment is involved.
class Element {
 tag:string;children:Element[]=[];dataset:Record<string,string>={};attributes:Record<string,string>={};
 handlers:Record<string,Function>={};className='';disabled=false;checked=false;open=false;value='';resetCount=0;private text='';
 constructor(tag:string){this.tag=tag;}
 get childElementCount(){return this.children.length;}
 set textContent(value:string){this.text=String(value);this.children=[];}
 get textContent():string{return this.text+this.children.map(n=>n.textContent).join('');}
 append(...nodes:Element[]){this.children.push(...nodes);}
 replaceChildren(...nodes:Element[]){this.text='';this.children=nodes;}
 reset(){this.resetCount++;}
 setAttribute(name:string,value:string){this.attributes[name]=value;}
 addEventListener(name:string,handler:Function){this.handlers[name]=handler;}
 querySelectorAll(selector:string):Element[]{
  const matches=(n:Element)=>selector==='details[open]'?n.tag==='details'&&n.open:selector.split(',').includes(n.tag);
  return this.children.flatMap(n=>[...(matches(n)?[n]:[]),...n.querySelectorAll(selector)]);
 }
}
const queued={id:'BILL-1',merchant:'supplier',payee:'merchant.test.near',amount_near:'0.4',state:'queued',outcome:'queued',error:null,explanation:null};
const snapshot=(bill:any)=>({vault:'vault.test.near',paused:false,policy:null,bills:[bill]});
for(const refreshFails of [false,true])test(`failed payment refreshes saved state and preserves its bill error (refresh failure: ${refreshFails})`,async t=>{
 const nodes=new Map<string,Element>();
 const get=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Element('div'));return nodes.get(selector)!;};
 const dom={querySelector:get,createElement:(tag:string)=>new Element(tag),createElementNS:(_:string,tag:string)=>new Element(tag)};
 const oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{value:dom,configurable:true});
 t.after(()=>{if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else delete (globalThis as any).document;});
 get('#agent-payments').append(get('#agent-bills'));
 const calls:string[]=[];let attempted=false;
 t.mock.method(globalThis,'fetch',async(path:any,options:any)=>{
  calls.push(`${options?.method??'GET'} ${path}`);
  if(options?.method==='POST'){
   attempted=true;return {ok:false,json:async()=>({error:'Model request failed'})} as Response;
  }
  if(attempted&&refreshFails)throw Error('read unavailable');
  return {ok:true,json:async()=>({ok:true,state:snapshot(attempted?{...queued,state:'proposal_failed',outcome:'failed',error:'Model proposal unavailable or rejected'}:queued)})} as Response;
 });
 const ui=await import(`./public/agent-payments.js?refreshFails=${refreshFails}`);
 await ui.refreshAgentPayments();
 assert.equal(get('#agent-feedback').textContent,'');
 assert.equal(get('#agent-refresh-status').textContent,'Agent vault refreshed');
 const pay=get('#agent-bills').querySelectorAll('button').find(n=>n.textContent==='Request payment')!;
 assert.ok(pay);await pay.handlers.click();
 assert.deepEqual(calls,['GET /api/agent/state','POST /api/agent/run','GET /api/agent/state']);
 const card=get('#agent-bills').children[0];
 assert.match(card.textContent,/Last request failedModel request failed/);
 assert.match(get('#agent-feedback').textContent,/Model request failed/);
 if(!refreshFails){
  assert.match(card.textContent,/Blocked/);assert.doesNotMatch(card.textContent,/Queued|Request payment/);
  assert.match(card.textContent,/Model proposal unavailable or rejected/);
 }else{
  assert.doesNotMatch(get('#agent-feedback').textContent,/read unavailable/);
 }
 assert.equal(get('#agent-payments').attributes['aria-busy'],'false');
});

test('collapsed file import blocks empty, pending and failed reads without paying or reusing an older bill',async t=>{
 const nodes=new Map<string,Element>();
 const get=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Element('div'));return nodes.get(selector)!;};
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{value:{querySelector:get,createElement:(tag:string)=>new Element(tag),createElementNS:(_:string,tag:string)=>new Element(tag)},configurable:true});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete (globalThis as any).document;});
 const calls:any[]=[];
 t.mock.method(globalThis,'fetch',async(path:any,options:any)=>{
  calls.push({path,body:JSON.parse(options.body)});
  return Response.json({ok:true,already_imported:false,record:queued,state:snapshot(queued)});
 });
 await import('./public/agent-payments.js?file-import');
 const form=get('#agent-import-form'),json=get('#agent-bill-json'),file=get('#agent-bill-file');
 const submit=()=>form.handlers.submit({preventDefault(){}});
 await submit();assert.equal(calls.length,0);assert.match(get('#agent-feedback').textContent,/Choose a signed bill file/);
 let finish:(text:string)=>void=()=>{};
 const reading=file.handlers.change({target:{files:[{size:40,text:()=>new Promise<string>(resolve=>finish=resolve)}]}});
 await submit();assert.equal(calls.length,0);assert.equal(get('#agent-payments').attributes['aria-busy'],'true');
 const signed={invoice:{id:'BILL-1'},signature:'fixture'};
 finish(JSON.stringify(signed));await reading;await submit();
 assert.deepEqual(calls,[{path:'/api/agent/import',body:{invoice:signed}}]);
 assert.equal(get('#agent-paste').open,false);assert.equal(form.resetCount,1);
 json.value=JSON.stringify(signed);
 await file.handlers.change({target:{files:[{size:17000,text:async()=>'{oversize}'}]}});
 await submit();assert.equal(calls.length,1);assert.equal(json.value,'');
 json.value=JSON.stringify(signed);
 await file.handlers.change({target:{files:[{size:40,text:async()=>{throw Error('read failure');}}]}});
 assert.match(get('#agent-feedback').textContent,/Could not read the file/);
 await submit();assert.equal(calls.length,1);assert.equal(json.value,'');
});
