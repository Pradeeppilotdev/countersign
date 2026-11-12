import {test} from 'node:test';
import assert from 'node:assert/strict';

// Drive the browser module through connection loss and recovery, without a
// running vault, model credentials or payment calls.
class Element {
 tag:string;children:Element[]=[];attributes:Record<string,string>={};handlers:Record<string,Function>={};className='';disabled=false;private text='';
 constructor(tag:string){this.tag=tag;}
 set textContent(value:string){this.text=String(value);this.children=[];}
 get textContent():string{return this.text+this.children.map(n=>n.textContent).join('');}
 append(...nodes:Element[]){this.children.push(...nodes);}
 replaceChildren(...nodes:Element[]){this.text='';this.children=nodes;}
 setAttribute(name:string,value:string){this.attributes[name]=value;}
 addEventListener(name:string,handler:Function){this.handlers[name]=handler;}
 querySelectorAll(selector:string):Element[]{return this.children.flatMap(n=>[...(selector.split(',').includes(n.tag)?[n]:[]),...n.querySelectorAll(selector)]);}
}
for(const failedOperation of ['refresh','setup'])test(`café refresh replaces a stale ${failedOperation} error only after a successful ledger read`,async t=>{
 const nodes=new Map<string,Element>();
 const get=(selector:string)=>{if(!nodes.has(selector))nodes.set(selector,new Element('div'));return nodes.get(selector)!;};
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 Object.defineProperty(globalThis,'document',{value:{querySelector:get,createElement:(tag:string)=>new Element(tag),createElementNS:(_:string,tag:string)=>new Element(tag)},configurable:true});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete (globalThis as any).document;});
 get('#demo-cafe').append(get('#cafe-actions'));
 const calls:string[]=[];
 let respond:()=>Promise<Response>=async()=>Response.json({ok:true,state:{ready:false}});
 t.mock.method(globalThis,'fetch',async(path:any,options:any)=>{
  calls.push(`${options?.method??'GET'} ${path}`);
  if(path==='/api/config')return Response.json({demoEnabled:true});
  if(path==='/api/agent/state')return Response.json({ok:true,state:{spending:{remaining_near:'1.2'}}});
  return respond();
 });
 const ui=await import(`./public/demo-cafe.js?recovery=${failedOperation}`);
 assert.equal(await ui.enableCafe(),true);
 await ui.refreshCafe();
 respond=async()=>{throw Error('connection lost');};
 if(failedOperation==='setup')await get('#cafe-actions').querySelectorAll('button')[0].handlers.click();
 else await ui.refreshCafe();
 const feedback=get('#cafe-feedback');
 assert.match(feedback.textContent,/Could not reach the local app/);
 assert.equal(feedback.children[0].className,'notice danger');
 const staleError=feedback.textContent;
 let finish:(response:Response)=>void=()=>{};
 respond=()=>new Promise(resolve=>finish=resolve);
 const refreshing=ui.refreshCafe();
 assert.equal(feedback.textContent,staleError,'keep the error until the ledger is actually read');
 assert.equal(get('#demo-cafe').attributes['aria-busy'],'true');
 finish(Response.json({ok:true,state:{ready:true,vault:'cafe.test.near',available:'4960000000000000000000000',policy:{per_payment_near:'0.5',rolling_24h_limit_near:'1.2',expires_at:Date.now()+3600000},suppliers:[],scam:{payee:'scam.test.near',received:'0'},bills:[],rejected:[],read_at:new Date().toISOString()}}));
 await refreshing;
 assert.match(get('#cafe-summary').textContent,/4\.96 test NEAR available/);
 assert.equal(feedback.textContent,'Ledger refreshed.');
 assert.equal(feedback.children[0].className,'notice success');
 assert.equal(get('#demo-cafe').attributes['aria-busy'],'false');
 respond=async()=>Response.json({ok:false,error:'Ledger is temporarily unavailable'});
 await ui.refreshCafe();
 assert.match(feedback.textContent,/Could not read café.*Ledger is temporarily unavailable/);
 assert.equal(feedback.children[0].className,'notice danger');
 assert.deepEqual(calls.filter(call=>call.startsWith('POST')),failedOperation==='setup'?['POST /api/demo/setup']:[]);
 assert.ok(calls.every(call=>/^GET \/api\/(config|agent\/state|demo\/state)$/.test(call)||call==='POST /api/demo/setup'));
});
