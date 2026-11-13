import {$,el,api,button,notice} from './components.js';
import {formatUnits,cafeBudgetSpent} from './state.js';
let enabled=false,busy=false,ask=null,askBill=null;
const root=$('#demo-cafe'),feedback=$('#cafe-feedback');
export function setCafeAsk(callback,billCallback=null){ask=callback;askBill=billCallback;}
export async function enableCafe(){
 try{enabled=(await api('/api/config')).demoEnabled===true;}catch{enabled=false;}
 $('#demo-nav').hidden=!enabled;return enabled;
}
function lock(){root.setAttribute('aria-busy',String(busy));root.querySelectorAll('button,input').forEach(n=>n.disabled=busy);}
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
function render(state,spending=null){
 const ids=['#cafe-summary','#cafe-actions','#cafe-ledger','#cafe-rejected','#cafe-bills','#cafe-rules','#cafe-bank-actions','#cafe-post-actions','#cafe-pay-actions','#cafe-end-actions','#cafe-queue','#cafe-results'];
 const [summary,actions,ledger,rejected,bills,rules,bank,post,pay,end,queue,results]=ids.map(id=>$(id));
 for(const target of [summary,actions,ledger,rejected,bills,rules,bank,post,pay,end,queue,results])target.replaceChildren();
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
 post.append(button("Receive today's invoices",()=>mutate('receive'),{tone:'primary'}));
 for(const bill of state.bills)bills.append(row(bill.id,bill.merchant+' · '+bill.amount_near+' NEAR',bill.outcome));
 if(!state.bills.length)bills.append(el('p','No invoices yet.','dw-muted'));
 for(const bill of state.rejected)rejected.append(row(bill.id,bill.reason,'rejected'));
 if(!state.rejected.length)rejected.append(el('p','No invoices rejected at intake.','dw-muted'));
 // 04 Agent pays
 const spent=cafeBudgetSpent(spending,state.bills,state.policy);
 pay.append(button('Pay all',()=>mutate('pay-all',{live:$('#cafe-live').checked}),{tone:'primary'}));
 const live=el('input');live.type='checkbox';live.id='cafe-live';const label=el('label','','cafe-live');label.append(live,el('span','Use live AI'));pay.append(label);
 // Sits with the payment results, beside Pay all.
 if(spent){const note=el('p',BUDGET_SPENT+' Topping up adds balance; it does not raise the daily budget (rolling 24 hours).','cafe-budget-note');note.setAttribute('role','status');pay.append(note);}
 const done=state.bills.filter(b=>['paid','blocked','failed'].includes(b.outcome));
 for(const bill of state.bills.filter(b=>!done.includes(b)))queue.append(row(bill.id,bill.merchant+' · '+bill.amount_near+' NEAR',bill.outcome));
 if(!queue.children?.length)queue.append(el('p','Nothing waiting.','dw-muted'));
 for(const bill of done){
  const item=row(bill.id,bill.merchant+' · '+bill.amount_near+' NEAR',bill.outcome);
  if(bill.error)item.append(el('p',bill.error,'dw-reason'));
  item.append(button('Ask Dave why',event=>askBill?.(bill,event.currentTarget),{tone:'ghost'}));results.append(item);
 }
 if(!done.length)results.append(el('p','No payments yet. Press Pay all.','dw-muted'));
 // 05 End of day
 for(const supplier of state.suppliers){
  const card=el('article','','cafe-supplier');
  card.append(el('h3',supplier.name),el('code',supplier.payee),el('strong',formatUnits(supplier.received)+' NEAR received','dw-mono'),el('p',supplier.paid_count+(supplier.paid_count===1?' bill paid':' bills paid'),'dw-muted'));
  if(!supplier.receipts.length)card.append(el('p','No paid invoices yet.','dw-muted'));
  for(const receipt of supplier.receipts){
   const detail=el('details');detail.append(el('summary',receipt.invoice_id+' · '+formatUnits(receipt.amount)+' NEAR'),
    el('code','State: '+receipt.state),el('code','Attempt ID: '+receipt.attempt_id),el('code','Signed payload hash: '+receipt.payload_hash));card.append(detail);
  }
  ledger.append(card);
 }
 const scam=el('article','','cafe-supplier');scam.append(el('h3','Scam payee'),el('code',state.scam.payee),el('strong',formatUnits(state.scam.received)+' NEAR received','dw-mono'),el('p','Live balance change since café setup.','dw-muted'));ledger.append(scam);
 $('#cafe-read-at').textContent='Live chain read · '+new Date(state.read_at).toLocaleTimeString()+'. Received totals exclude initial account funding.';
 end.append(button('Refresh ledger',()=>refreshCafe(),{tone:'ghost'}),button('Start a new day',()=>mutate('reset'),{tone:'secondary'}));
}
export async function refreshCafe(){
 if(!enabled||busy)return;busy=true;lock();
 try{const reply=await api('/api/demo/state');if(!reply.ok)throw Error(reply.error);render(reply.state,await readSpending(reply.state));notice(feedback,'Ledger refreshed.','success');}
 catch(error){notice(feedback,'Could not read café','danger',error.message);}finally{busy=false;lock();}
}
async function mutate(action,body={}){
 if(!enabled||busy)return;busy=true;lock();notice(feedback,action==='pay-all'?'Paying queued invoices…':'Updating café…','busy');
 let polling=false;
 const timer=action==='pay-all'?setInterval(async()=>{
  if(polling)return;polling=true;
  try{const reply=await api('/api/demo/progress');if(reply.ok&&reply.progress.running)$('#cafe-progress').textContent=`${reply.progress.completed} / ${reply.progress.total} processed · ${reply.progress.current??'Starting'}`;}catch{}finally{polling=false;}
 },1200):null;
 try{const reply=await api('/api/demo/'+action,body);if(!reply.ok)throw Error(reply.error);render(reply.state,await readSpending(reply.state));notice(feedback,action==='pay-all'?'Payment run complete. Review the results and the supplier ledger.':'Café updated.','success');}
 catch(error){notice(feedback,'Café operation could not finish','danger',error.message);}
 finally{clearInterval(timer);$('#cafe-progress').textContent='';busy=false;lock();}
}
$('#cafe-ask').addEventListener('click',event=>ask?.(event.currentTarget));
