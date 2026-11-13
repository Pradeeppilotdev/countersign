import {test} from 'node:test';
import assert from 'node:assert/strict';

// Step 2 of the demo world: invoice documents, mailbox, results and the viewer.
// A small fake DOM drives the real browser modules without a vault or model.
class Element {
 tag:string;children:Element[]=[];attributes:Record<string,string>={};handlers:Record<string,Function>={};
 className='';id='';type='';disabled=false;hidden=false;isConnected=true;private text='';
 constructor(tag:string){this.tag=tag;}
 set textContent(value:string){this.text=String(value);this.children=[];}
 get textContent():string{return this.text+this.children.map(n=>n.textContent).join('');}
 append(...nodes:Element[]){this.children.push(...nodes);}
 replaceChildren(...nodes:Element[]){this.text='';this.children=nodes;}
 setAttribute(name:string,value:string){this.attributes[name]=value;}
 addEventListener(name:string,handler:Function){this.handlers[name]=handler;}
 focus(){(globalThis as any).document.activeElement=this;}
 querySelectorAll(selector:string):Element[]{return all(this).filter(n=>selector.split(',').includes(n.tag));}
 click(){return this.handlers.click?.({currentTarget:this,target:this,preventDefault(){}});}
}
const all=(node:Element):Element[]=>node.children.flatMap(n=>[n,...all(n)]);
const shape=(node:Element):string=>`${node.tag}.${node.className}[${node.children.map(shape).join(',')}]`;

const YOCTO=10n**24n;
const near=(n:string)=>{const [w,f='']=n.split('.');return (BigInt(w)*YOCTO+BigInt((f+'0'.repeat(24)).slice(0,24))).toString();};
const invoice=(id:string,merchant:string,supplier:string,payee:string,amount:string,week:number|null=null)=>
 ({id,merchant,supplier,payee,amount:near(amount),expires_at:String(Date.now()+3600000),week});
const BEANS1=invoice('INV-BEANS-01-abc12345','Bean-Co','Bean Co','beans.test.near','0.4');
const MILK1=invoice('INV-MILK-01-abc12345','Milk-Co','Milk Co','milk.test.near','0.4',1);
const BEANS3=invoice('INV-BEANS-03-abc12345','Bean-Co','Bean Co','scam.test.near','0.4');
const PASTRY2=invoice('INV-PASTRY-02-abc12345','Pastry-Co','Pastry Co','pastry.test.near','0.5');
const STATE={ready:true,vault:'cafe.test.near',available:near('4.2'),policy:{per_payment_near:'0.5',rolling_24h_limit_near:'1.2',expires_at:Date.now()+3600000,min_payment_near:'0.005'},
 mail:{issued_at:new Date().toISOString(),invoices:[BEANS3,BEANS1,MILK1,PASTRY2]},
 rejected:[{...BEANS3,reason:'Invalid merchant signature'}],
 bills:[
  {id:BEANS1.id,merchant:'Bean-Co',payee:'beans.test.near',amount_near:'0.4',outcome:'paid',error:null,explanation:null},
  {id:MILK1.id,merchant:'Milk-Co',payee:'milk.test.near',amount_near:'0.4',outcome:'blocked',error:'Service period already claimed',explanation:{meaning:'Another invoice already used this service week.'}},
  {id:PASTRY2.id,merchant:'Pastry-Co',payee:'pastry.test.near',amount_near:'0.5',outcome:'queued',error:null,explanation:null},
 ],
 suppliers:[{id:'Bean-Co',name:'Bean Co',payee:'beans.test.near',received:near('0.4'),paid_count:1,receipts:[{invoice_id:BEANS1.id,amount:near('0.4'),attempt_id:'7',payload_hash:'ab'.repeat(32),state:'Settled'}]},
  {id:'Milk-Co',name:'Milk Co',payee:'milk.test.near',received:'0',paid_count:0,receipts:[]}],
 scam:{payee:'scam.test.near',received:'0'},read_at:new Date().toISOString()};

function fakeDocument(t:any){
 const nodes=new Map<string,Element>();
 const get=(selector:string)=>{if(!nodes.has(selector)){const n=new Element('div');n.id=selector.slice(1);nodes.set(selector,n);}return nodes.get(selector)!;};
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
 const doc={querySelector:get,createElement:(tag:string)=>new Element(tag),createElementNS:(_:string,tag:string)=>new Element(tag),activeElement:null as any};
 Object.defineProperty(globalThis,'document',{value:doc,configurable:true});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else delete (globalThis as any).document;});
 get('#viewer-hidden');get('#dw-viewer').hidden=true;
 return {get,doc};
}
async function loadCafe(t:any,label:string,posts:string[]=[]){
 const dom=fakeDocument(t);
 t.mock.method(globalThis,'fetch',async(path:any,options:any)=>{
  if(options?.method==='POST')posts.push(path);
  if(path==='/api/config')return Response.json({demoEnabled:true});
  if(path==='/api/agent/state')return Response.json({ok:true,state:{spending:{remaining_near:'1.2'}}});
  return Response.json({ok:true,state:STATE});
 });
 const ui=await import(`./public/demo-cafe.js?case=${label}`);
 const asked:string[]=[];ui.setCafeAsk((_:any,text='How is my agent doing?')=>asked.push(text),(bill:any)=>asked.push('bill:'+bill.id));
 assert.equal(await ui.enableCafe(),true);await ui.refreshCafe();
 return {...dom,ui,asked};
}
const byText=(root:Element,text:string)=>all(root).find(n=>n.tag==='button'&&n.textContent===text);

test('invoice line items always add up exactly to the invoice amount', async () => {
 const {lineItems}=await import('./public/invoice-doc.js');
 for(const merchant of ['Bean-Co','Milk-Co','Pastry-Co','Unknown-Co'])
  for(const amount of [near('0.4'),near('0.5'),'1','2','7','19','999999999999999999999999','123456789012345678901234567',near('0.000000000000000000000013')]){
   const lines=lineItems(merchant,amount);
   assert.equal(lines.reduce((sum:bigint,l:any)=>sum+BigInt(l.amount),0n),BigInt(amount),`${merchant} ${amount}`);
   assert.ok(lines.every((l:any)=>BigInt(l.amount)>=0n));
  }
 assert.deepEqual(lineItems('Bean-Co',near('0.4')).map((l:any)=>[l.label,l.amount]),[['House roast beans, 20 kg',near('0.36')],['Delivery',near('0.04')]]);
 assert.deepEqual(lineItems('Pastry-Co',near('0.5')).map((l:any)=>l.amount),[near('0.425'),near('0.075')]);
});

test('a tampered invoice is drawn with exactly the same markup as a genuine one', async t => {
 fakeDocument(t);
 const {invoiceDocument}=await import('./public/invoice-doc.js?markup');
 const good=invoiceDocument(BEANS1,STATE.mail.issued_at),bad=invoiceDocument(BEANS3,STATE.mail.issued_at);
 assert.equal(shape(bad),shape(good));
 assert.deepEqual(bad.attributes['aria-label'].replace('03','01'),good.attributes['aria-label']);
 const text=bad.textContent;
 assert.match(text,/Bean Co.*Coffee roasters.*INVOICE.*BEANS-03.*Billed to.*Dave's Café.*Issued.*Due.*House roast beans, 20 kg.*Delivery.*Total due.*0\.4 NEAR.*Pay to.*scam\.test\.near.*Digitally signed by Bean Co · Ed25519/s);
 assert.doesNotMatch(text,/reject|tamper|invalid|warning|fake/i);
 assert.match(invoiceDocument(MILK1,STATE.mail.issued_at).textContent,/DueWeek 1/);
});

test('the mailbox lists every delivered invoice the same way, including the one rejected at intake', async t => {
 const {get,asked}=await loadCafe(t,'mailbox');
 const items=get('#cafe-bills').children;
 assert.equal(items.length,4);
 assert.equal(get('#dw-post-title').textContent,'4 invoices arrived');
 assert.ok(items.every(i=>i.className==='dw-mail-item'&&i.tag==='button'));
 assert.equal(new Set(items.map(shape)).size,1,'no tell-tale markup in the mailbox');
 assert.match(items[0].textContent,/Bean CoBEANS-03Due .*0\.4 NEAR/);
 assert.equal(items[0].attributes['aria-pressed'],'true','the first invoice is open by default');
 // The rejected one is open: its second action is the muted line, not a button.
 assert.match(get('#dw-invoice').textContent,/BEANS-03.*scam\.test\.near/s);
 assert.match(get('#dw-invoice-actions').textContent,/Hand all 4 to my agent →Dave can explain this one after your agent tries it\./);
 items[1].click();
 assert.equal(items.length,4);
 assert.equal(get('#cafe-bills').children[1].attributes['aria-pressed'],'true');
 assert.match(get('#dw-invoice').textContent,/BEANS-01.*beans\.test\.near/s);
 byText(get('#dw-invoice-actions'),'Ask Dave about this invoice')!.click();
 assert.deepEqual(asked,[`Tell me about invoice ${BEANS1.id}`]);
});

test('results show one row per invoice in delivery order, with REJECTED and the signature sentence', async t => {
 const {get,asked}=await loadCafe(t,'results');
 const rows=get('#cafe-results').children;
 assert.deepEqual(rows.map(r=>r.children[0].textContent),['Bean Co · BEANS-03REJECTED','Bean Co · BEANS-01PAID','Milk Co · MILK-01STOPPED']);
 assert.equal(rows[0].children[1].textContent,"The signature doesn't match. Something on this invoice was changed after Bean Co signed it.");
 assert.equal(rows[2].children[1].textContent,'Another invoice already used this service week.');
 assert.equal(byText(rows[1],'Ask Dave why'),undefined,'paid rows have nothing to explain');
 byText(rows[0],'Ask Dave why')!.click();byText(rows[2],'Ask Dave why')!.click();
 assert.deepEqual(asked,['Why was the Bean Co invoice BEANS-03 rejected?','bill:'+MILK1.id]);
 assert.match(get('#cafe-queue').textContent,/Pastry Co · PASTRY-02QUEUED/);
});

test('the invoice viewer opens from results and from ledger receipts, and closes with Esc', async t => {
 const {get,doc}=await loadCafe(t,'viewer');
 const viewer=get('#dw-viewer');
 const fromResults=byText(get('#cafe-results'),'Bean Co · BEANS-03')!;
 fromResults.click();
 assert.equal(viewer.hidden,false);
 assert.equal(get('#dw-viewer-title').textContent,'Invoice BEANS-03');
 assert.match(get('#dw-viewer-body').textContent,/INVOICEBEANS-03.*scam\.test\.near/s);
 assert.equal(doc.activeElement,get('#dw-viewer-close'),'focus moves into the dialog');
 get('#demo-cafe').handlers.keydown({key:'Escape',preventDefault(){}});
 assert.equal(viewer.hidden,true);
 assert.equal(doc.activeElement,fromResults,'focus returns to the opener');
 const fromLedger=byText(get('#cafe-ledger'),'BEANS-01 · 0.4 NEAR')!;
 fromLedger.click();
 assert.equal(viewer.hidden,false);
 assert.match(get('#dw-viewer-body').textContent,/BEANS-01.*House roast beans.*beans\.test\.near/s);
 get('#dw-viewer-close').click();
 assert.equal(viewer.hidden,true);
});

test('handing the pile to the agent runs the existing Pay all and leaves no success banner', async t => {
 const posts:string[]=[];
 const {get}=await loadCafe(t,'hand-all',posts);
 assert.equal(get('#cafe-feedback').textContent,'');
 await byText(get('#dw-invoice-actions'),'Hand all 4 to my agent →')!.click();
 assert.deepEqual(posts,['/api/demo/pay-all']);
 assert.equal(get('#cafe-feedback').textContent,'');
 assert.equal(get('#cafe-feedback').children.length,0);
});
