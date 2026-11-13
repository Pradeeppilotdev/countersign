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
const YOCTO=10n**24n,GAS_RESERVE=YOCTO/2n,RESERVE_MESSAGE='Keep 0.5 NEAR in your wallet for fees.';
// Display only: whole NEAR plus up to 4 decimals, truncated. Exact value in the title.
export function shortNear(yocto){
 const v=BigInt(yocto),fraction=(v%YOCTO).toString().padStart(24,'0').slice(0,4).replace(/0+$/,'');
 return (fraction?`${v/YOCTO}.${fraction}`:String(v/YOCTO))+' NEAR';
}
// Same rules as the server, in exact BigInt maths; returns an error message or null.
export function depositProblem(value,walletYocto){
 const amount=toYocto(value);
 if(amount===null)return 'Enter an amount in NEAR, like 2 or 0.25 (up to 24 decimals).';
 if(amount<=0n)return 'Enter an amount greater than 0.';
 const wallet=BigInt(walletYocto??0),limit=wallet>GAS_RESERVE?wallet-GAS_RESERVE:0n;
 if(amount>limit)return `You can deposit up to ${formatUnits(limit.toString())} NEAR. ${RESERVE_MESSAGE}`;
 return null;
}
// Exact NEAR → yoctoNEAR, zero allowed (callers say why zero is refused); null if malformed.
function toYocto(value){
 const text=String(value??'').trim();if(!/^\d{1,9}(\.\d{1,24})?$/.test(text))return null;
 const [whole,fraction='']=text.split('.');return BigInt(whole)*YOCTO+BigInt(fraction.padEnd(24,'0'));
}
function balance(node,yocto){node.textContent=yocto==null?'—':shortNear(yocto);if(yocto!=null)node.setAttribute('title',formatUnits(yocto)+' NEAR');}
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
 const ids=['#cafe-summary','#cafe-actions','#cafe-ledger','#cafe-bills','#cafe-rules','#cafe-post-actions','#cafe-pay-actions','#cafe-end-actions','#cafe-queue','#cafe-results','#dw-invoice','#dw-invoice-actions'];
 const [summary,actions,ledger,bills,rules,post,pay,end,queue,results]=ids.map(id=>$(id));
 for(const id of ids)$(id).replaceChildren();
 $('#cafe-read-at').textContent='';
 if(!state.ready){
  for(const id of ['#dw-vault','#dw-wallet','#dw-bank-vault','#dw-bank-wallet'])$(id).textContent='—';
  $('#cafe-wallet-actions').replaceChildren();$('#dw-bank-history').replaceChildren();
  actions.append(el('p',state.existing?'An agent vault exists. Reset backs it up before opening a fresh café.':'Open a café with three suppliers and 5 test NEAR.','dw-muted'));
  actions.append(button(state.existing?'Reset café':'Open the café',()=>mutate(state.existing?'reset':'setup'),{tone:'primary'}));
  return;
 }
 // 01 The bank: Dave's wallet and the vault, kept apart.
 const wallet=state.wallet_yocto??null;
 balance($('#dw-vault'),state.available);balance($('#dw-bank-vault'),state.available);
 balance($('#dw-wallet'),wallet);balance($('#dw-bank-wallet'),wallet);
 summary.append(fact('Vault account','Local sandbox · '+state.vault+' · '+formatUnits(state.available)+' test NEAR available'));
 const walletActions=$('#cafe-wallet-actions');walletActions.replaceChildren(button('Get 5 test NEAR',()=>mutate('wallet-faucet'),{tone:'primary'}));
 const history=$('#dw-bank-history');history.replaceChildren();
 for(const entry of [...(state.bank??[])].reverse()){
  const item=el('div','','dw-row dw-history');
  item.append(el('span',new Date(entry.at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),'dw-mono dw-muted'),
   el('span',entry.kind==='faucet'?"Got test NEAR into Dave's wallet":'Deposited into the vault'),el('strong',formatUnits(entry.amount)+' NEAR','dw-mono'));
  history.append(item);
 }
 if(!state.bank?.length)history.append(el('p','Nothing yet today.','dw-muted'));
 // 02 Your rules: editable limits, read-only suppliers.
 renderRules(state);
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
const MAX_RULE_HOURS=24,MAX_RULE_YOCTO=5n*YOCTO;
// Same messages as the server's parseDemoRules, in exact BigInt maths.
export function rulesProblem(values,minimumNear=null){
 const amount=(label,value)=>{
  const v=toYocto(value);if(v===null)return [null,`${label}: enter an amount in NEAR, like 0.5 (up to 24 decimals).`];
  if(v<=0n)return [null,`${label}: enter an amount greater than 0.`];
  if(v>MAX_RULE_YOCTO)return [null,`${label}: the local sandbox allows at most 5 NEAR.`];
  return [v,null];
 };
 const [per,perError]=amount('Most per bill',values.per_bill);if(perError)return perError;
 const [daily,dailyError]=amount('Daily budget',values.daily_budget);if(dailyError)return dailyError;
 if(per>daily)return "Most per bill can't be more than the daily budget.";
 const hours=String(values.hours??'').trim();
 if(!/^\d{1,4}$/.test(hours)||Number(hours)<1||Number(hours)>MAX_RULE_HOURS)return `Rules can last from 1 to ${MAX_RULE_HOURS} hours.`;
 if(minimumNear!=null&&per<(toYocto(minimumNear)??0n))return `Most per bill must be at least the minimum payment (${minimumNear} NEAR).`;
 return null;
}
const expiryOf=policy=>Number(policy?.expires_at_ms??new Date(policy?.expires_at).getTime());
function renderRules(state){
 const policy=state.policy,rules=$('#cafe-rules');rules.replaceChildren();
 const expires=expiryOf(policy),expired=policy?.expired===true||(Number.isFinite(expires)&&expires<=Date.now());
 const banner=$('#dw-rules-expired');banner.hidden=!expired;
 $('#dw-rules-expired-text').textContent=expired?`Your rules expired at ${new Date(expires).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}. Your agent can't pay anything until you renew them.`:'';
 $('#dw-per-bill').value=policy?.per_payment_near??'';
 $('#dw-daily').value=policy?.rolling_24h_limit_near??'';
 const left=Math.ceil((expires-Date.now())/3600000);
 $('#dw-hours').value=String(expired||!Number.isFinite(left)?2:Math.min(MAX_RULE_HOURS,Math.max(1,left)));
 $('#dw-rules-expiry').textContent=Number.isFinite(expires)?(expired?'Expired at ':'Current rules end at ')+new Date(expires).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'.':'';
 const payee=id=>(policy?.merchants??[]).find(m=>m.id===id)?.payee;
 for(const supplier of state.suppliers??[]){
  const item=el('div','','dw-row dw-fact');item.append(el('span',supplier.name),el('strong',payee(supplier.id)??supplier.payee,'dw-mono'));rules.append(item);
 }
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
async function mutate(action,body={},inline=null){
 if(!enabled||busy)return false;busy=true;lock();notice(feedback,action==='pay-all'?'Paying queued invoices…':'Updating café…','busy');
 let polling=false;
 const timer=action==='pay-all'?setInterval(async()=>{
  if(polling)return;polling=true;
  try{const reply=await api('/api/demo/progress');if(reply.ok&&reply.progress.running)$('#cafe-progress').textContent=`${reply.progress.completed} / ${reply.progress.total} processed · ${reply.progress.current??'Starting'}`;}catch{}finally{polling=false;}
 },1200):null;
 try{const reply=await api('/api/demo/'+action,body);if(!reply.ok)throw Error(reply.error);render(reply.state,await readSpending(reply.state));notice(feedback,'');return true;}
 catch(error){
  // Form errors stay next to the field; everything else uses the status line.
  if(inline){notice(feedback,'');inline.textContent=error.message;}
  else notice(feedback,'Café operation could not finish','danger',error.message);
  return false;
 }
 finally{clearInterval(timer);$('#cafe-progress').textContent='';busy=false;lock();}
}
$('#cafe-ask').addEventListener('click',event=>ask?.(event.currentTarget));
$('#dw-viewer-close').addEventListener('click',()=>closeViewer());
$('#dw-rules-form').addEventListener('submit',async event=>{
 event.preventDefault?.();if(busy)return;
 const values={per_bill:String($('#dw-per-bill').value??'').trim(),daily_budget:String($('#dw-daily').value??'').trim(),hours:String($('#dw-hours').value??'').trim()};
 const error=$('#dw-rules-error'),saved=$('#dw-rules-saved'),problem=rulesProblem(values,current?.policy?.min_payment_near??null);
 error.textContent=problem??'';saved.textContent='';
 if(problem)return;
 if(await mutate('set-rules',values,error)){
  const until=expiryOf(current?.policy);
  saved.textContent='Rules saved.'+(Number.isFinite(until)?' They last until '+new Date(until).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})+'.':'');
 }
});
$('#dw-rules-renew').addEventListener('click',async()=>{
 $('#dw-rules-saved').textContent='';$('#dw-rules-error').textContent='';
 if(await mutate('renew-rules',{},$('#dw-rules-error')))$('#dw-rules-saved').textContent='Rules renewed for 2 hours, with the same limits.';
});
$('#dw-deposit').addEventListener('submit',async event=>{
 event.preventDefault?.();if(busy)return;
 const input=$('#dw-deposit-amount'),error=$('#dw-deposit-error'),value=String(input.value??'').trim();
 const problem=depositProblem(value,current?.wallet_yocto);
 error.textContent=problem??'';
 if(problem)return;
 if(await mutate('deposit',{amount:value},error))input.value='';
});
$('#dw-viewer').addEventListener('click',event=>{if(event.target===$('#dw-viewer'))closeViewer();});
root.addEventListener('keydown',event=>{
 if($('#dw-viewer').hidden)return;
 if(event.key==='Escape'){event.preventDefault();closeViewer();}
 // The close button is the only control inside the viewer: keep focus there.
 else if(event.key==='Tab'){event.preventDefault();$('#dw-viewer-close').focus?.();}
});
