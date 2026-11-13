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
const BEANS3=invoice('INV-BEANS-03-abc12345','Bean-Co','Bean Co','bean5.test.near','0.4');
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
 scam:{payee:'bean5.test.near',received:'0'},read_at:new Date().toISOString(),
 wallet_yocto:'7499876543210987654321098',bank:[{at:new Date().toISOString(),kind:'faucet',amount:near('5')},{at:new Date().toISOString(),kind:'deposit',amount:near('2')}]};

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
 const asked:string[]=[];ui.setCafeAsk((_:any,text='How is my agent doing?')=>asked.push(text),(bill:any)=>asked.push('bill:'+bill.id),(account:string)=>asked.push('account:'+account));
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
 assert.match(text,/Bean Co.*Coffee roasters.*INVOICE.*BEANS-03.*Billed to.*Dave's Café.*Issued.*Due.*House roast beans, 20 kg.*Delivery.*Total due.*0\.4 NEAR.*Pay to.*bean5\.test\.near.*Digitally signed by Bean Co · Ed25519/s);
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
 // The rejected one is open, with exactly the same document and buttons as a good one.
 assert.match(get('#dw-invoice').textContent,/BEANS-03.*bean5\.test\.near/s);
 const badDoc=shape(get('#dw-invoice')),badActions=shape(get('#dw-invoice-actions'));
 assert.equal(get('#dw-invoice-actions').textContent,'Hand all 4 to my agent →Ask Dave: would you pay this account?');
 byText(get('#dw-invoice-actions'),'Ask Dave: would you pay this account?')!.click();
 get('#cafe-bills').children[1].click();
 assert.equal(get('#cafe-bills').children[1].attributes['aria-pressed'],'true');
 assert.match(get('#dw-invoice').textContent,/BEANS-01.*beans\.test\.near/s);
 assert.equal(shape(get('#dw-invoice')),badDoc);
 assert.equal(shape(get('#dw-invoice-actions')),badActions);
 assert.equal(get('#dw-invoice-actions').textContent,'Hand all 4 to my agent →Ask Dave: would you pay this account?');
 byText(get('#dw-invoice-actions'),'Ask Dave: would you pay this account?')!.click();
 // The account check runs on the Pay to account written on each invoice.
 assert.deepEqual(asked,['account:bean5.test.near','account:beans.test.near']);
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
 assert.match(get('#dw-viewer-body').textContent,/INVOICEBEANS-03.*bean5\.test\.near/s);
 assert.equal(doc.activeElement,get('#dw-viewer-close'),'focus moves into the dialog');
 get('#demo-cafe').handlers.keydown({key:'Escape',preventDefault(){}});
 assert.equal(viewer.hidden,true);
 assert.equal(doc.activeElement,fromResults,'focus returns to the opener');
 assert.match(get('#cafe-ledger').textContent,/bean5\.test\.near0 NEAR received · not a supplier/);
 assert.ok(!get('#cafe-ledger').textContent.includes('Scam payee'));
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

test('the bank shows Dave\'s wallet and the vault apart, in the top bar too, with today\'s history', async t => {
 const {get}=await loadCafe(t,'bank');
 assert.equal(get('#dw-wallet').textContent,'7.4998 NEAR');
 assert.equal(get('#dw-bank-wallet').textContent,'7.4998 NEAR');
 assert.equal(get('#dw-bank-wallet').attributes.title,'7.499876543210987654321098 NEAR');
 assert.equal(get('#dw-vault').textContent,'4.2 NEAR');
 assert.equal(get('#dw-bank-vault').textContent,'4.2 NEAR');
 assert.equal(get('#cafe-wallet-actions').textContent,'Get 5 test NEAR');
 assert.match(get('#dw-bank-history').textContent,/Deposited into the vault2 NEAR.*Got test NEAR into Dave's wallet5 NEAR/);
 for(const id of ['#cafe-summary','#cafe-wallet-actions','#cafe-actions','#cafe-pay-actions','#cafe-end-actions'])
  assert.ok(!get(id).textContent.includes('Top up vault'),'the old one-click top-up is not shown: '+id);
});

test('deposit amounts are checked in exact BigInt maths before anything is sent', async t => {
 const posts:string[]=[];
 const {get,ui}=await loadCafe(t,'deposit',posts);
 const wallet='5000000000000000000000000';
 assert.equal(ui.depositProblem('4.5',wallet),null);
 assert.equal(ui.depositProblem('0.000000000000000000000001',wallet),null);
 assert.match(ui.depositProblem('4.500000000000000000000001',wallet),/^You can deposit up to 4\.5 NEAR\. Keep 0\.5 NEAR in your wallet for fees\.$/);
 for(const bad of ['0','0.000','-1','abc','1.','1e2','1.0000000000000000000000001',''])assert.ok(ui.depositProblem(bad,wallet),bad);
 assert.match(ui.depositProblem('1','400000000000000000000000'),/up to 0 NEAR/);
 // Over the limit in the form: inline error, no request.
 get('#dw-deposit-amount').value='99';
 await get('#dw-deposit').handlers.submit({preventDefault(){}});
 assert.match(get('#dw-deposit-error').textContent,/Keep 0\.5 NEAR in your wallet for fees\./);
 assert.deepEqual(posts,[]);
 get('#dw-deposit-amount').value='2';
 await get('#dw-deposit').handlers.submit({preventDefault(){}});
 assert.equal(get('#dw-deposit-error').textContent,'');
 assert.deepEqual(posts,['/api/demo/deposit']);
 assert.equal(get('#dw-deposit-amount').value,'');
});

test('your rules: prefilled form, exact checks before sending, read-only suppliers', async t => {
 const posts:string[]=[];
 const {get,ui}=await loadCafe(t,'rules',posts);
 assert.equal(get('#dw-per-bill').value,'0.5');
 assert.equal(get('#dw-daily').value,'1.2');
 assert.equal(get('#dw-hours').value,'1');
 assert.equal(get('#dw-rules-expired').hidden,true,'no banner while the rules are live');
 assert.match(get('#cafe-rules').textContent,/Bean Cobeans\.test\.near.*Milk Comilk\.test\.near/);
 const ok={per_bill:'0.5',daily_budget:'2',hours:'3'};
 assert.equal(ui.rulesProblem(ok),null);
 assert.equal(ui.rulesProblem({...ok,per_bill:'3'}),"Most per bill can't be more than the daily budget.");
 assert.equal(ui.rulesProblem({...ok,per_bill:'0'}),'Most per bill: enter an amount greater than 0.');
 assert.match(ui.rulesProblem({...ok,daily_budget:'x'}),/^Daily budget: enter an amount/);
 assert.equal(ui.rulesProblem({...ok,hours:'25'}),'Rules can last from 1 to 24 hours.');
 assert.equal(ui.rulesProblem({...ok,hours:'0'}),'Rules can last from 1 to 24 hours.');
 assert.equal(ui.rulesProblem({...ok,per_bill:'0.001'},'0.005'),'Most per bill must be at least the minimum payment (0.005 NEAR).');
 assert.equal(ui.rulesProblem({per_bill:'0.500000000000000000000001',daily_budget:'0.5',hours:'2'}),"Most per bill can't be more than the daily budget.");
 get('#dw-per-bill').value='3';get('#dw-daily').value='2';get('#dw-hours').value='3';
 await get('#dw-rules-form').handlers.submit({preventDefault(){}});
 assert.equal(get('#dw-rules-error').textContent,"Most per bill can't be more than the daily budget.");
 assert.deepEqual(posts,[]);
 get('#dw-per-bill').value='0.5';
 await get('#dw-rules-form').handlers.submit({preventDefault(){}});
 assert.equal(get('#dw-rules-error').textContent,'');
 assert.deepEqual(posts,['/api/demo/set-rules']);
 assert.match(get('#dw-rules-saved').textContent,/^Rules saved\./);
});

test('expired rules show the banner, and renew keeps the same limits', async t => {
 const posts:string[]=[];
 const expiredAt=Date.now()-60000;
 const saved=STATE.policy;(STATE as any).policy={...saved,expires_at:expiredAt,expired:true};
 t.after(()=>{(STATE as any).policy=saved;});
 const {get}=await loadCafe(t,'expired',posts);
 assert.equal(get('#dw-rules-expired').hidden,false);
 assert.match(get('#dw-rules-expired-text').textContent,/^Your rules expired at .+\. Your agent can't pay anything until you renew them\.$/);
 assert.equal(get('#dw-hours').value,'2');
 await get('#dw-rules-renew').handlers.click({});
 assert.deepEqual(posts,['/api/demo/renew-rules']);
});

const withState=(t:any,patch:any)=>{const saved={...STATE};Object.assign(STATE,patch);t.after(()=>{for(const k of Object.keys(patch))delete (STATE as any)[k];Object.assign(STATE,saved);});};
const rowTitles=(node:Element)=>node.children.map(r=>r.children[0]?.textContent);

test('during Pay all, results fill in one at a time in processing order with a live counter', async t => {
 const {get,ui}=await loadCafe(t,'live-run');
 const base={running:true,order:[MILK1.id,BEANS1.id,PASTRY2.id],vault_before:near('5'),total:3};
 ui.renderRun({...base,results:[],current:MILK1.id,completed:0});
 assert.deepEqual(rowTitles(get('#cafe-results')),['Bean Co · BEANS-03REJECTED','Milk Co · MILK-01Checking…']);
 assert.deepEqual(get('#cafe-queue').children.map(r=>r.children[0].textContent),['Bean Co · BEANS-01QUEUED','Pastry Co · PASTRY-02QUEUED']);
 assert.equal(get('#dw-run-counts').textContent,'0 paid · 0 stopped · 1 rejected');
 assert.equal(get('#dw-run-vault').textContent,'Vault 5 → 5 NEAR');
 ui.renderRun({...base,current:BEANS1.id,completed:1,results:[{id:MILK1.id,outcome:'blocked',error:'Service period already claimed',explanation:{meaning:'Another invoice already used this service week.'}}]});
 assert.deepEqual(rowTitles(get('#cafe-results')),['Bean Co · BEANS-03REJECTED','Milk Co · MILK-01STOPPED','Bean Co · BEANS-01Checking…']);
 ui.renderRun({...base,current:PASTRY2.id,completed:2,results:[{id:MILK1.id,outcome:'blocked',error:'x',explanation:null},{id:BEANS1.id,outcome:'paid',error:null,explanation:null}]});
 assert.deepEqual(rowTitles(get('#cafe-results')),['Bean Co · BEANS-03REJECTED','Milk Co · MILK-01STOPPED','Bean Co · BEANS-01PAID','Pastry Co · PASTRY-02Checking…']);
 assert.equal(get('#dw-run-counts').textContent,'1 paid · 1 stopped · 1 rejected');
 assert.equal(get('#dw-run-vault').textContent,'Vault 5 → 4.6 NEAR');
 assert.equal(get('#cafe-queue').textContent,'Nothing waiting.');
 assert.ok(!all(get('#cafe-results')).some(n=>n.tag==='button'&&/Try again|Ask Dave/.test(n.textContent)),'no actions mid-run');
});

test('after the run, results keep processing order, the counter matches, and only budget stops offer Try again', async t => {
 const posts:string[]=[];
 withState(t,{run:{order:[PASTRY2.id,MILK1.id,BEANS1.id],vault_before:near('5')},day_vault_start:near('5'),available:near('4.6'),
  bills:[
   {id:BEANS1.id,merchant:'Bean-Co',payee:'beans.test.near',amount_near:'0.4',outcome:'paid',error:null,explanation:null,has_proposal:true},
   {id:MILK1.id,merchant:'Milk-Co',payee:'milk.test.near',amount_near:'0.4',outcome:'blocked',error:'Service period already claimed by [INV-MILK-02-abc12345].',explanation:{meaning:'Another invoice already used this service week.'},has_proposal:true},
   {id:PASTRY2.id,merchant:'Pastry-Co',payee:'pastry.test.near',amount_near:'0.5',outcome:'blocked',error:'Rolling daily budget exceeded.',explanation:{meaning:'Paying this would take the last 24 hours of spending over your daily budget.'},has_proposal:true},
  ]});
 const {get,ui}=await loadCafe(t,'after-run',posts);
 assert.deepEqual(rowTitles(get('#cafe-results')),['Bean Co · BEANS-03REJECTED','Pastry Co · PASTRY-02STOPPED','Milk Co · MILK-01STOPPED','Bean Co · BEANS-01PAID']);
 assert.equal(get('#dw-run-counts').textContent,'1 paid · 2 stopped · 1 rejected');
 assert.equal(get('#dw-run-vault').textContent,'Vault 5 → 4.6 NEAR');
 const rows=get('#cafe-results').children,retry=(r:Element)=>byText(r,'Try again');
 assert.ok(retry(rows[1]),'budget-stopped row offers Try again');
 assert.equal(retry(rows[0]),undefined);assert.equal(retry(rows[2]),undefined);assert.equal(retry(rows[3]),undefined);
 assert.equal(ui.canRetry({outcome:'blocked',error:'Rolling daily budget exceeded.',has_proposal:false}),false);
 await retry(rows[1])!.click();
 assert.deepEqual(posts,['/api/demo/retry']);
});

test('End of day totals match the ledger and list what was stopped and why', async t => {
 withState(t,{day_vault_start:near('5'),available:near('4.2'),
  suppliers:[{id:'Bean-Co',name:'Bean Co',payee:'beans.test.near',received:near('0.4'),paid_count:1,receipts:[{invoice_id:BEANS1.id,amount:near('0.4'),attempt_id:'7',payload_hash:'ab'.repeat(32),state:'Settled'}]},
   {id:'Milk-Co',name:'Milk Co',payee:'milk.test.near',received:near('0.4'),paid_count:1,receipts:[{invoice_id:MILK1.id,amount:near('0.4'),attempt_id:'8',payload_hash:'cd'.repeat(32),state:'Settled'}]},
   {id:'Pastry-Co',name:'Pastry Co',payee:'pastry.test.near',received:'0',paid_count:0,receipts:[]}],
  bills:[
   {id:BEANS1.id,merchant:'Bean-Co',payee:'beans.test.near',amount_near:'0.4',outcome:'paid',error:null,explanation:null},
   {id:MILK1.id,merchant:'Milk-Co',payee:'milk.test.near',amount_near:'0.4',outcome:'paid',error:null,explanation:null},
   {id:PASTRY2.id,merchant:'Pastry-Co',payee:'pastry.test.near',amount_near:'0.5',outcome:'blocked',error:'Rolling daily budget exceeded.',explanation:{meaning:'Over the daily budget.'},has_proposal:true},
  ]});
 const {get,ui,asked}=await loadCafe(t,'end-of-day');
 const totals=ui.endTotals(STATE,ui.resultOrder(STATE,STATE.mail.invoices));
 const ledgerSum=STATE.suppliers.reduce((s:bigint,x:any)=>s+BigInt(x.received),0n).toString();
 assert.deepEqual(totals,{paid:ledgerSum,suppliers:2,stopped:1,rejected:1,vault_start:near('5'),vault_now:near('4.2')});
 assert.deepEqual(get('#dw-end-stats').children.map(c=>c.textContent),['Paid 0.8 NEARto 2 suppliers','Stopped 1bill','Rejected 1at intake','Vault: 5 → 4.2 NEARsince the first run today']);
 assert.match(get('#cafe-ledger').textContent,/Bean Co0\.4 NEAR1 bill paid · beans\.test\.nearBEANS-01 · 0\.4 NEAR/);
 assert.ok(byText(get('#cafe-ledger'),'MILK-01 · 0.4 NEAR'),'each paid invoice opens the viewer');
 assert.deepEqual(rowTitles(get('#dw-end-stopped')),['Bean Co · BEANS-03REJECTED','Pastry Co · PASTRY-02STOPPED']);
 assert.match(get('#dw-end-stopped').textContent,/The signature doesn't match.*Over the daily budget\./s);
 assert.equal(byText(get('#dw-end-stopped'),'Try again'),undefined);
 byText(get('#cafe-end-actions'),'Ask Dave how today went')!.click();
 assert.deepEqual(asked,['How is my agent doing?']);
 assert.ok(byText(get('#cafe-end-actions'),'Start a new day'));
});
