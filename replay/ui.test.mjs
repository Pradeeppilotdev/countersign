import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compileEvidence} from '../scripts/replay-evidence.mjs';
class Element{
 constructor(tag='div'){this.tag=tag;this.children=[];this.handlers={};this.attributes={};this.text='';this.hidden=false;this.disabled=false;}
 set textContent(v){this.text=String(v);this.children=[];}get textContent(){return this.text+this.children.map(n=>n.textContent).join('');}
 append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.text='';this.children=nodes;}
 setAttribute(k,v){this.attributes[k]=v;}addEventListener(k,fn){this.handlers[k]=fn;}
}
for(const unavailable of [false,true])test(`browser replay reads static evidence once and never submits a payment (unavailable: ${unavailable})`,async t=>{
 const ids=[...readFileSync(new URL('./index.html',import.meta.url),'utf8').matchAll(/id="([^"]+)"/g)].map(m=>m[1]);
 const nodes=new Map(ids.map(id=>[id,new Element()]));
 const old=Object.getOwnPropertyDescriptor(globalThis,'document');Object.defineProperty(globalThis,'document',{configurable:true,value:{getElementById:id=>{assert.ok(nodes.has(id),id);return nodes.get(id);},createElement:tag=>new Element(tag)}});
 t.after(()=>{if(old)Object.defineProperty(globalThis,'document',old);else delete globalThis.document;});
 const calls=[];const read=p=>JSON.parse(readFileSync(new URL(p,import.meta.url)));
 const evidence=compileEvidence(read('../docs/attack-results/result.json'),read('../docs/testnet-cafe.json'),read('./receipt-verification.json'));
 evidence.provenance={commit:'a'.repeat(40),sources:[]};
 t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push({path,options});if(unavailable)throw Error('Unavailable');return Response.json(evidence);});
 await import(`./app.js?unavailable=${unavailable}`);
 const get=id=>nodes.get(id);
 assert.equal(get('loading').hidden,true);
 if(unavailable){assert.equal(get('load-error').hidden,false);assert.equal(get('replay-content').hidden,true);}
 else{
  assert.equal(get('replay-content').hidden,false);assert.equal(get('received').textContent,'0.00');
  for(let round=0;round<2;round++){
   for(let i=0;i<3;i++)get('next').handlers.click();
   assert.equal(get('received').textContent,'0.04');assert.equal(get('retry').textContent,'0.00 NEAR');assert.equal(get('next').disabled,true);
   get('next').handlers.click();assert.equal(get('position').textContent,'4 / 4');
   get('choose-cafe').handlers.click();assert.equal(get('received').textContent,'0.40');
   get('next').handlers.click();assert.equal(get('received').textContent,'0.00');assert.match(get('worker').textContent,/invalid merchant signature/);
   for(let i=0;i<3;i++)get('next').handlers.click();
   assert.equal(get('received').textContent,'0.30');assert.match(get('receipt-link').href,/^https:\/\/testnet.nearblocks.io\/txns\//);
   get('choose-weekly').handlers.click();assert.equal(get('received').textContent,'0.00');assert.equal(get('previous').disabled,true);
  }
  get('steps').children[2].children[0].handlers.click();assert.match(get('worker').textContent,/Stopped/);assert.equal(get('received').textContent,'0.04');
 }
 assert.deepEqual(calls,[{path:'./evidence.json',options:undefined}]);
});
