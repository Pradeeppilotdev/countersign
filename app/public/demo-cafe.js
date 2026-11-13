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
const BUDGET_SPENT="Today's budget is spent: the vault is doing its job. Bills blocked by the budget can be resumed once earlier payments are 24 hours old, or raise the daily budget in Your rules and press Try again. Policy and invoice expiry still apply. Press Start a new day to reset the café.";
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
// Today's delivered invoices, in delivery order. Older café data without a
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
 const result=decision(state,invoice);
 if(['queued','proposed'].includes(result.outcome))actions.append(button('Pay this invoice',()=>payOne(invoice.id),{tone:'secondary'}));
 else actions.append(el('span',`Status: ${TAGS[result.outcome]?.[0]??String(result.outcome).toUpperCase()}`,'dw-tag '+(TAGS[result.outcome]?.[1]??'neutral')));
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
  item.addEventListener('click',()=>{
   selected=invoice.id;
   // Keep focus and the mobile strip's scroll position on the chosen invoice.
   bills.querySelectorAll('button').forEach(node=>node.setAttribute('aria-pressed',String(node===item)));
   renderDocument(state,list);
  });
  bills.append(item);
 }
 if(!list.length)bills.append(el('p','No invoices yet. Receive today\'s post.','dw-muted'));
}
function render(state,spending=null){
 current=state;
 for(const id of ['#dw-rules-error','#dw-rules-saved','#dw-deposit-error'])$(id).textContent='';
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
 const ordered=resultOrder(state,list),counts={paid:0,stopped:0,rejected:0};
 for(const invoice of ordered){
  const result=decision(state,invoice);
  if(!DECIDED.includes(result.outcome)){
   const item=row(invoice.supplier+' · '+shortBill(invoice.id),formatUnits(invoice.amount)+' NEAR',result.outcome);
   if(['queued','proposed'].includes(result.outcome))item.append(button('Pay',()=>payOne(invoice.id),{tone:'secondary'}));
   queue.append(item);continue;
  }
  count(counts,result.outcome);results.append(resultRow(invoice,result));
 }
 if(!queue.children?.length)queue.append(el('p','Nothing waiting.','dw-muted'));
 if(!results.children?.length)results.append(el('p','No payments yet. Press Pay all.','dw-muted'));
 showCounter(counts,state.run?.vault_before??null,state.available);
 // 05 End of day
 renderEnd(state,ordered);
 end.append(button('Ask Dave how today went',event=>ask?.(event.currentTarget),{tone:'primary'}),
  button('Start a new day',()=>mutate('reset'),{tone:'secondary'}),button('Refresh ledger',()=>refreshCafe(),{tone:'ghost'}));
}
const BUDGET_STOP=/rolling daily budget exceeded/i;
// Only a bill the vault stopped for the daily budget, with its saved proposal, can be tried again.
export const canRetry=bill=>bill?.outcome==='blocked'&&bill.has_proposal===true&&BUDGET_STOP.test(bill.error??'');
// Processing order: refused at intake first, then the latest run's order, then the rest as delivered.
export function resultOrder(state,list){
 const byId=new Map(list.map(i=>[i.id,i])),seen=new Set(),out=[];
 const add=invoice=>{if(invoice&&!seen.has(invoice.id)){seen.add(invoice.id);out.push(invoice);}};
 for(const invoice of list)if(decision(state,invoice).outcome==='rejected')add(invoice);
 for(const id of state.run?.order??[])add(byId.get(id));
 for(const invoice of list)add(invoice);
 return out;
}
function count(counts,outcome){if(outcome==='paid')counts.paid++;else if(outcome==='rejected')counts.rejected++;else if(DECIDED.includes(outcome))counts.stopped++;}
export function counterText(counts){return `${counts.paid} paid · ${counts.stopped} stopped · ${counts.rejected} rejected`;}
function showCounter(counts,before,now){
 const any=counts.paid+counts.stopped+counts.rejected>0;
 $('#dw-run-counts').textContent=any?counterText(counts):'';
 $('#dw-run-vault').textContent=any&&before!=null&&now!=null?`Vault ${formatUnits(before)} → ${formatUnits(now)} NEAR`:'';
}
// One result row. checking: the bill the agent is on right now. live: during a run (no actions yet).
function resultRow(invoice,result,{checking=false,live=false}={}){
 const title=invoice.supplier+' · '+shortBill(invoice.id),item=el('div','','dw-row dw-result'),head=el('div','','dw-row-head');
 head.append(nameButton(invoice,title),checking?el('span','Checking…','dw-tag neutral dw-checking'):tag(result.outcome));item.append(head);
 if(checking||result.outcome==='paid')return item;
 if(result.reason)item.append(el('p',result.reason,'dw-reason'));
 if(live)return item;
 const actions=el('div','','dw-row-actions');
 if(canRetry(result.bill))actions.append(button('Try again',()=>mutate('retry',{id:invoice.id}),{tone:'secondary'}));
 const why=result.outcome==='rejected'
  ?event=>ask?.(event.currentTarget,`Why was the ${invoice.supplier} invoice ${shortBill(invoice.id)} rejected?`)
  :event=>askBill?.(result.bill,event.currentTarget);
 actions.append(button('Ask Dave why',why,{tone:'ghost'}));item.append(actions);
 return item;
}
// Live run: rows change only when the server reports a finished bill.
export function renderRun(progress){
 if(!current||!progress?.order)return;
 const list=mailbox(current),byId=new Map(list.map(i=>[i.id,i])),results=$('#cafe-results'),queue=$('#cafe-queue');
 results.replaceChildren();queue.replaceChildren();
 const counts={paid:0,stopped:0,rejected:0},done=new Set();let paid=0n;
 for(const invoice of list){const result=decision(current,invoice);if(result.outcome==='rejected'){count(counts,'rejected');results.append(resultRow(invoice,result,{live:true}));}}
 for(const finished of progress.results??[]){
  const invoice=byId.get(finished.id);if(!invoice)continue;done.add(finished.id);
  count(counts,finished.outcome);if(finished.outcome==='paid')paid+=BigInt(invoice.amount);
  results.append(resultRow(invoice,{outcome:finished.outcome,reason:finished.explanation?.meaning??finished.error??null},{live:true}));
 }
 if(progress.current&&!done.has(progress.current)&&byId.has(progress.current))results.append(resultRow(byId.get(progress.current),null,{checking:true}));
 for(const id of progress.order){
  if(done.has(id)||id===progress.current||!byId.has(id))continue;
  const invoice=byId.get(id);queue.append(row(invoice.supplier+' · '+shortBill(invoice.id),formatUnits(invoice.amount)+' NEAR','queued'));
 }
 if(!queue.children?.length)queue.append(el('p','Nothing waiting.','dw-muted'));
 const before=progress.vault_before??null;
 showCounter(counts,before,before==null?null:(BigInt(before)-paid).toString());
}
// End of day totals come from the on-chain ledger and the vault's own outcomes.
export function endTotals(state,ordered){
 const paidTo=(state.suppliers??[]).filter(s=>BigInt(s.received)>0n);
 const total=paidTo.reduce((sum,s)=>sum+BigInt(s.received),0n),counts={paid:0,stopped:0,rejected:0};
 for(const invoice of ordered)count(counts,decision(state,invoice).outcome);
 return {paid:total.toString(),suppliers:paidTo.length,stopped:counts.stopped,rejected:counts.rejected,vault_start:state.day_vault_start??null,vault_now:state.available};
}
function renderEnd(state,ordered){
 const totals=endTotals(state,ordered),stats=$('#dw-end-stats'),ledger=$('#cafe-ledger'),stopped=$('#dw-end-stopped');
 stats.replaceChildren();stopped.replaceChildren();
 const stat=(value,label)=>{const item=el('div','','dw-stat');item.append(el('strong',value,'dw-mono'),el('span',label,'dw-muted'));stats.append(item);};
 stat(`Paid ${formatUnits(totals.paid)} NEAR`,`to ${totals.suppliers} ${totals.suppliers===1?'supplier':'suppliers'}`);
 stat(`Stopped ${totals.stopped}`,totals.stopped===1?'bill':'bills');
 stat(`Rejected ${totals.rejected}`,'at intake');
 if(totals.vault_start===null)stat(`Vault: ${formatUnits(totals.vault_now)} NEAR`,'current available balance');
 else stat(`Vault: ${formatUnits(totals.vault_start)} → ${formatUnits(totals.vault_now)} NEAR`,'since the first run today');
 for(const supplier of state.suppliers){
  const item=el('div','','dw-row dw-ledger-row'),head=el('div','','dw-row-head');
  head.append(el('strong',supplier.name),el('strong',formatUnits(supplier.received)+' NEAR','dw-mono dw-green'));
  item.append(head,el('p',supplier.paid_count+(supplier.paid_count===1?' bill paid':' bills paid')+' · '+supplier.payee,'dw-muted'));
  const links=el('div','','dw-ledger-links');
  for(const receipt of supplier.receipts){
   const invoice=invoiceFor(receipt.invoice_id,{id:receipt.invoice_id,merchant:supplier.id,supplier:supplier.name,payee:supplier.payee,amount:receipt.amount,expires_at:null,week:null});
   links.append(nameButton(invoice,shortBill(receipt.invoice_id)+' · '+formatUnits(receipt.amount)+' NEAR'));
  }
  if(supplier.receipts.length)item.append(links);
  ledger.append(item);
 }
 const scam=el('div','','dw-row dw-ledger-row'),scamHead=el('div','','dw-row-head');
 scamHead.append(el('strong',state.scam.payee,'dw-mono'),el('strong',formatUnits(state.scam.received)+' NEAR received · not a supplier','dw-mono'));
 scam.append(scamHead);ledger.append(scam);
 $('#cafe-read-at').textContent='Live chain read · '+new Date(state.read_at).toLocaleTimeString()+'. Received totals exclude initial account funding.';
 for(const invoice of ordered){
  const result=decision(state,invoice);
  if(['blocked','failed','rejected'].includes(result.outcome))stopped.append(resultRow(invoice,{...result,bill:result.bill?{...result.bill,has_proposal:false}:null}));
 }
 if(!stopped.children?.length)stopped.append(el('p','Nothing was stopped today.','dw-muted'));
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
function payOne(id){
 if(globalThis.location&&location.hash!=='#demo/pay')location.hash='#demo/pay';
 return mutate('pay-one',{id});
}
export async function refreshCafe(){
 if(!enabled||busy)return;busy=true;lock();
 try{const reply=await api('/api/demo/state');if(!reply.ok)throw Error(reply.error);render(reply.state,await readSpending(reply.state));notice(feedback,'');}
 catch(error){notice(feedback,'Could not read café','danger',error.message);}finally{busy=false;lock();}
}
async function mutate(action,body={},inline=null){
 if(!enabled||busy)return false;busy=true;lock();notice(feedback,action==='pay-all'||action==='pay-one'?'Paying queued invoices…':'Updating café…','busy');
 let polling=false;
 const timer=['pay-all','pay-one'].includes(action)?setInterval(async()=>{
  if(polling)return;polling=true;
  try{
   const reply=await api('/api/demo/progress');
   if(reply.ok&&reply.progress.running){$('#cafe-progress').textContent=`${reply.progress.completed} / ${reply.progress.total} processed`;renderRun(reply.progress);}
  }catch{}finally{polling=false;}
 },700):null;
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
