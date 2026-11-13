import {$,el,api,button,notice} from './components.js';
import {formatUnits,parseUnits,cafeBudgetSpent} from './state.js';
import {invoiceDocument,shortBill,dueLine,SIGNATURE_SENTENCE} from './invoice-doc.js';
let enabled=false,busy=false,ask=null,askBill=null,askAccount=null,selected=null,opener=null;
const root=$('#demo-cafe'),feedback=$('#cafe-feedback');
export function setCafeAsk(callback,billCallback=null,accountCallback=null){ask=callback;askBill=billCallback;askAccount=accountCallback;}
export async function enableCafe(){
 try{enabled=(await api('/api/config')).demoEnabled===true;}catch{enabled=false;}
 $('#demo-nav').hidden=!enabled;return enabled;
}
function lock(){root.setAttribute('aria-busy',String(busy));root.querySelectorAll('button,input').forEach(n=>{if(n.id!=='dw-viewer-close')n.disabled=busy;});}
const BUDGET_SPENT="Today's budget is spent: the vault is doing its job. Bills blocked by the budget can be resumed once earlier payments are 24 hours old. Policy and invoice expiry still apply. Press Start a new day to reset the café.";
// The existing Agent payments state already carries the vault's rolling usage.
async function readSpending(state){
 if(!state.ready)return null;
 try{const reply=await api('/api/agent/state');return reply.ok?reply.state.spending:null;}catch{return null;}
}
const TAGS={paid:['PAID','paid'],rejected:['REJECTED','stopped'],blocked:['STOPPED','stopped'],failed:['STOPPED','stopped'],queued:['QUEUED','neutral'],proposed:['QUEUED','neutral'],pending:['PENDING','warn']};
function tag(outcome){const [label,tone]=TAGS[outcome]??[String(outcome).toUpperCase(),'neutral'];return el('span',label,'dw-tag '+tone);}
function row(title,detail,outcome=null){
 const item=el('div','','dw-row'),head=el('div','','dw-row-head');head.append(el('strong',title,'dw-mono'));
 if(outcome)head.append(tag(outcome));item.append(head);if(detail)item.append(el('p',detail,'dw-muted'));return item;
}
function fact(label,value){const item=el('div','','dw-row dw-fact');item.append(el('span',label,'dw-label'),el('strong',value,'dw-mono'));return item;}
// Invoices from the latest receive, in delivery order. Older café data without a
// mail copy falls back to the agent's bill list.
export function mailbox(state){
 if(state.mail?.invoices?.length)return state.mail.invoices;
 const name=id=>state.suppliers?.find(s=>s.id===id)?.name??id;
 return (state.bills??[]).map(b=>({id:b.id,merchant:b.merchant,supplier:name(b.merchant),payee:b.payee,amount:parseUnits(b.amount_near),expires_at:null,week:null}));
}
// What the vault (or intake) decided for one invoice, in plain words.
export function decision(state,invoice){
 const rejected=state.rejected?.find(r=>r.id===invoice.id);
 if(rejected)return {outcome:'rejected',reason:/invalid merchant signature/i.test(rejected.reason)?SIGNATURE_SENTENCE(invoice.supplier):rejected.reason,bill:null};
 const bill=state.bills?.find(b=>b.id===invoice.id);
 if(!bill)return {outcome:'queued',reason:null,bill:null};
 return {outcome:bill.outcome,reason:bill.explanation?.meaning??bill.error??null,bill};
}
const DECIDED=['paid','blocked','failed','rejected'];
let current=null;
function invoiceFor(id,fallback){return mailbox(current).find(i=>i.id===id)??fallback;}
function nameButton(invoice,label){
 const link=el('button',label,'dw-link');link.type='button';
 link.addEventListener('click',event=>openViewer(invoice,event.currentTarget));return link;
}
function openViewer(invoice,trigger){
 opener=trigger??null;
 $('#dw-viewer-title').textContent='Invoice '+shortBill(invoice.id);
 $('#dw-viewer-body').replaceChildren(invoiceDocument(invoice,current?.mail?.issued_at));
 $('#dw-viewer').hidden=false;$('#dw-viewer-close').focus?.();
}
function closeViewer(){
 if($('#dw-viewer').hidden)return;
 $('#dw-viewer').hidden=true;
 if(opener?.isConnected!==false)opener?.focus?.();opener=null;
}
function renderDocument(state,list){
 const target=$('#dw-invoice'),actions=$('#dw-invoice-actions');target.replaceChildren();actions.replaceChildren();
 const invoice=list.find(i=>i.id===selected);if(!invoice)return;
 target.append(invoiceDocument(invoice,state.mail?.issued_at));
 actions.append(button(`Hand all ${list.length} to my agent →`,()=>handAll(),{tone:'primary'}));
 // Identical for every invoice: check the account written on it, no model involved.
 actions.append(button('Ask Dave: would you pay this account?',event=>askAccount?.(invoice.payee,event.currentTarget),{tone:'secondary'}));
}
function renderMailbox(state,list){
 const bills=$('#cafe-bills');bills.replaceChildren();
 $('#dw-post-title').textContent=list.length?`${list.length} invoices arrived`:"Today's post";
 if(!list.some(i=>i.id===selected))selected=list[0]?.id??null;
 for(const invoice of list){
  // Every invoice is drawn identically; nothing marks the bad ones.
  const item=el('button','','dw-mail-item');item.type='button';
  item.setAttribute('aria-pressed',String(invoice.id===selected));
  const head=el('span','','dw-mail-head');head.append(el('strong',invoice.supplier),el('span',shortBill(invoice.id),'dw-mono dw-muted'));
  const foot=el('span','','dw-mail-foot');foot.append(el('span',invoice.week?dueLine(invoice):'Due '+dueLine(invoice),'dw-muted'),el('span',formatUnits(invoice.amount)+' NEAR','dw-mono'));
  item.append(head,foot);
  item.addEventListener('click',()=>{selected=invoice.id;renderMailbox(state,list);renderDocument(state,list);});
  bills.append(item);
 }
 if(!list.length)bills.append(el('p','No invoices yet. Receive today\'s post.','dw-muted'));
}
function render(state,spending=null){
 current=state;
 const ids=['#cafe-summary','#cafe-actions','#cafe-ledger','#cafe-bills','#cafe-rules','#cafe-bank-actions','#cafe-post-actions','#cafe-pay-actions','#cafe-end-actions','#cafe-queue','#cafe-results','#dw-invoice','#dw-invoice-actions'];
 const [summary,actions,ledger,bills,rules,bank,post,pay,end,queue,results]=ids.map(id=>$(id));
 for(const id of ids)$(id).replaceChildren();
 $('#cafe-read-at').textContent='';
 if(!state.ready){
  $('#dw-vault').textContent='—';
  actions.append(el('p',state.existing?'An agent vault exists. Reset backs it up before opening a fresh café.':'Open a café with three suppliers and 5 test NEAR.','dw-muted'));
  actions.append(button(state.existing?'Reset café':'Open the café',()=>mutate(state.existing?'reset':'setup'),{tone:'primary'}));
  return;
 }
 $('#dw-vault').textContent=formatUnits(state.available)+' NEAR';
 // 01 The bank
 summary.append(fact('Vault','Local sandbox · '+state.vault),fact('Balance',formatUnits(state.available)+' test NEAR available'));
 bank.append(button('Top up vault (+5 test NEAR)',()=>mutate('faucet'),{tone:'primary'}));
 // 02 Your rules (read only)
 rules.append(fact('Per payment',state.policy.per_payment_near+' NEAR'),fact('Daily budget',state.policy.rolling_24h_limit_near+' NEAR · rolling 24 hours'),
  fact('Expires',new Date(state.policy.expires_at).toLocaleTimeString()),
  fact('Suppliers','Bean Co, Milk Co and Pastry Co have pinned signing keys and payouts. Milk Co has a weekly service.'));
 // 03 Morning post
 const list=mailbox(state);
 post.append(button("Receive today's invoices",()=>mutate('receive'),{tone:list.length?'secondary':'primary'}));
 renderMailbox(state,list);renderDocument(state,list);
 // 04 Agent pays
 const spent=cafeBudgetSpent(spending,state.bills,state.policy);
 pay.append(button('Pay all',()=>mutate('pay-all',{live:$('#cafe-live').checked===true}),{tone:'primary'}));
 const live=el('input');live.type='checkbox';live.id='cafe-live';const label=el('label','','cafe-live');label.append(live,el('span','Use live AI'));pay.append(label);
 // Sits with the payment results, beside Pay all.
 if(spent){const note=el('p',BUDGET_SPENT+' Topping up adds balance; it does not raise the daily budget (rolling 24 hours).','cafe-budget-note');note.setAttribute('role','status');pay.append(note);}
 let decided=0;
 for(const invoice of list){
  const result=decision(state,invoice),title=invoice.supplier+' · '+shortBill(invoice.id);
  if(!DECIDED.includes(result.outcome)){queue.append(row(title,formatUnits(invoice.amount)+' NEAR',result.outcome));continue;}
  decided++;
  const item=el('div','','dw-row dw-result'),head=el('div','','dw-row-head');
  head.append(nameButton(invoice,title),tag(result.outcome));item.append(head);
  if(result.outcome!=='paid'){
   if(result.reason)item.append(el('p',result.reason,'dw-reason'));
   const why=result.outcome==='rejected'
    ?event=>ask?.(event.currentTarget,`Why was the ${invoice.supplier} invoice ${shortBill(invoice.id)} rejected?`)
    :event=>askBill?.(result.bill,event.currentTarget);
   item.append(button('Ask Dave why',why,{tone:'ghost'}));
  }
  results.append(item);
 }
 if(!queue.children?.length)queue.append(el('p','Nothing waiting.','dw-muted'));
 if(!decided)results.append(el('p','No payments yet. Press Pay all.','dw-muted'));
 // 05 End of day
 for(const supplier of state.suppliers){
  const card=el('article','','cafe-supplier');
  card.append(el('h3',supplier.name),el('code',supplier.payee),el('strong',formatUnits(supplier.received)+' NEAR received','dw-mono'),el('p',supplier.paid_count+(supplier.paid_count===1?' bill paid':' bills paid'),'dw-muted'));
  if(!supplier.receipts.length)card.append(el('p','No paid invoices yet.','dw-muted'));
  for(const receipt of supplier.receipts){
   const invoice=invoiceFor(receipt.invoice_id,{id:receipt.invoice_id,merchant:supplier.id,supplier:supplier.name,payee:supplier.payee,amount:receipt.amount,expires_at:null,week:null});
   const line=el('div','','dw-receipt');line.append(nameButton(invoice,shortBill(receipt.invoice_id)+' · '+formatUnits(receipt.amount)+' NEAR'));
   const detail=el('details');detail.append(el('summary','Proof'),el('code','Invoice: '+receipt.invoice_id),
    el('code','State: '+receipt.state),el('code','Attempt ID: '+receipt.attempt_id),el('code','Signed payload hash: '+receipt.payload_hash));
   line.append(detail);card.append(line);
  }
  ledger.append(card);
 }
 const scam=el('article','','cafe-supplier');scam.append(el('h3',state.scam.payee+' · not a supplier'),el('code',state.scam.payee),el('strong',formatUnits(state.scam.received)+' NEAR received','dw-mono'),el('p','Live balance change since café setup.','dw-muted'));ledger.append(scam);
 $('#cafe-read-at').textContent='Live chain read · '+new Date(state.read_at).toLocaleTimeString()+'. Received totals exclude initial account funding.';
 end.append(button('Refresh ledger',()=>refreshCafe(),{tone:'secondary'}),button('Start a new day',()=>mutate('reset'),{tone:'secondary'}));
}
function handAll(){
 if(globalThis.location&&location.hash!=='#demo/pay')location.hash='#demo/pay';
 return mutate('pay-all',{live:$('#cafe-live').checked===true});
}
export async function refreshCafe(){
 if(!enabled||busy)return;busy=true;lock();
 try{const reply=await api('/api/demo/state');if(!reply.ok)throw Error(reply.error);render(reply.state,await readSpending(reply.state));notice(feedback,'');}
 catch(error){notice(feedback,'Could not read café','danger',error.message);}finally{busy=false;lock();}
}
async function mutate(action,body={}){
 if(!enabled||busy)return;busy=true;lock();notice(feedback,action==='pay-all'?'Paying queued invoices…':'Updating café…','busy');
 let polling=false;
 const timer=action==='pay-all'?setInterval(async()=>{
  if(polling)return;polling=true;
  try{const reply=await api('/api/demo/progress');if(reply.ok&&reply.progress.running)$('#cafe-progress').textContent=`${reply.progress.completed} / ${reply.progress.total} processed · ${reply.progress.current??'Starting'}`;}catch{}finally{polling=false;}
 },1200):null;
 try{const reply=await api('/api/demo/'+action,body);if(!reply.ok)throw Error(reply.error);render(reply.state,await readSpending(reply.state));notice(feedback,'');}
 catch(error){notice(feedback,'Café operation could not finish','danger',error.message);}
 finally{clearInterval(timer);$('#cafe-progress').textContent='';busy=false;lock();}
}
$('#cafe-ask').addEventListener('click',event=>ask?.(event.currentTarget));
$('#dw-viewer-close').addEventListener('click',()=>closeViewer());
$('#dw-viewer').addEventListener('click',event=>{if(event.target===$('#dw-viewer'))closeViewer();});
root.addEventListener('keydown',event=>{
 if($('#dw-viewer').hidden)return;
 if(event.key==='Escape'){event.preventDefault();closeViewer();}
 // The close button is the only control inside the viewer: keep focus there.
 else if(event.key==='Tab'){event.preventDefault();$('#dw-viewer-close').focus?.();}
});
