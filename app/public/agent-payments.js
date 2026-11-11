import {$,el,icon,badge,button,notice,emptyState,api} from './components.js';

const root=$('#agent-payments'),list=$('#agent-bills'),feedback=$('#agent-feedback');
let state=null,busy=false,reading=false,revision=0;
const liveChoices=new Map();
const labels={paid:['Paid','success'],blocked:['Blocked','danger'],failed:['Blocked','danger'],pending:['Pending','warning'],queued:['Queued','neutral'],proposed:['Queued','neutral'],cancelled:['Cancelled','neutral']};
function lock(){
 root.setAttribute('aria-busy',String(busy||reading));
 root.querySelectorAll('button,input,textarea').forEach(n=>{n.disabled=busy||reading;});
}
function row(label,value){const node=el('div','','kv');node.append(el('span',label),el('strong',value??'Unavailable'));return node;}
function renderRules(s){
 const target=$('#agent-rules');target.replaceChildren();
 const p=s.policy;
 target.append(row('Payments paused',s.paused===null?'Unavailable':s.paused?'Yes':'No'));
 if(!p){target.append(el('p','No spending policy is set.','agent-rule-note'));return;}
 target.append(row('Policy',p.expired?'Expired':'Active'),row('Per payment',p.per_payment_near+' NEAR'),
  row('Rolling 24h used',s.spending.used_near+' NEAR'),row('Rolling 24h limit',s.spending.limit_near+' NEAR'),
  row('Rolling 24h remaining',s.spending.remaining_near+' NEAR'),row('Minimum',p.min_payment_near+' NEAR'),
  row('Expires',p.expires_at?new Date(p.expires_at).toLocaleString():'Unavailable'));
 target.append(el('h3','Pinned suppliers','agent-suppliers-title'));
 for(const m of p.merchants){
  const key=s.merchants.find(k=>k.merchant_id===m.id);
  const supplier=el('div','','agent-supplier');
  supplier.append(el('strong',m.id),el('small',m.payee),badge(key?.active?'Signing key pinned':'No active signing key',key?.active?'success':'warning'));
  target.append(supplier);
 }
}
function renderBills(){
 const expanded=new Set([...list.querySelectorAll('details[open]')].map(n=>n.dataset.invoice));
 list.replaceChildren();$('#agent-bill-count').textContent=String(state?.bills.length??0);
 if(!state?.bills.length){list.append(emptyState('Bring your first signed bill','Import a supplier’s signed JSON bill. Your vault checks every payment against your rules.'));return;}
 for(const bill of state.bills.slice().reverse()){
  const card=el('article','','invoice-card');card.setAttribute('aria-label','Bill '+bill.id);card.dataset.invoice=bill.id;
  const top=el('div','','invoice-top'),symbol=el('span','','invoice-symbol'),identity=el('div','','invoice-identity'),value=el('div','','invoice-value');
  symbol.append(icon(bill.outcome==='paid'?'check-circle':'receipt'));
  identity.append(el('h3',bill.id),el('small',bill.merchant),el('small',bill.payee));
  const [label,tone]=labels[bill.outcome]??['Pending','warning'];
  value.append(el('strong',bill.amount_near+' NEAR'),badge(label,tone));top.append(symbol,identity,value);card.append(top);
  if(bill.error||bill.explanation){
   const reason=el('div');notice(reason,bill.error??label,tone,bill.explanation?.meaning??'');card.append(reason);
  }
  const actions=el('div','','invoice-actions');
  if(['queued','proposed'].includes(bill.outcome)){
   const live=el('input');live.type='checkbox';live.checked=liveChoices.get(bill.id)??false;
   live.addEventListener('change',()=>liveChoices.set(bill.id,live.checked));
   const choice=el('label','','agent-live');choice.append(live,el('span','Use live AI'));
   actions.append(button('Request payment',()=>mutate('/api/agent/run',{id:bill.id,live:live.checked},'Checking the bill and requesting payment…'),{tone:'primary',iconName:'arrow-right'}),choice);
  }else if(bill.outcome==='pending'||(bill.outcome==='blocked'&&bill.has_proposal)){
   actions.append(button('Resume',()=>mutate('/api/agent/resume',{id:bill.id},'Resuming the saved payment…'),{tone:'secondary'}));
  }
  if(actions.childElementCount)card.append(actions);
  if(bill.outcome==='paid'){
   const receipt=el('details','','invoice-meta');receipt.dataset.invoice=bill.id;receipt.open=expanded.has(bill.id);
   receipt.append(el('summary','Receipt'),el('code','Attempt ID: '+(bill.attempt_id??'Unavailable')),
    el('code','Transaction hash: '+(bill.tx_hash??'Not available for this local receipt')),
    el('code','Signed payload hash: '+(bill.payload_hash??'Unavailable')));
   if(bill.network==='testnet'&&typeof bill.tx_hash==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(bill.tx_hash)){
    const link=el('a','View on NearBlocks testnet');link.href='https://testnet.nearblocks.io/txns/'+bill.tx_hash;link.target='_blank';link.rel='noopener noreferrer';receipt.append(link);
   }
   card.append(receipt);
  }
  list.append(card);
 }
 lock();
}
function render(s){state=s;$('#agent-source').textContent='Local agent vault · '+s.vault;renderRules(s);renderBills();}
export async function refreshAgentPayments(){
 if(busy||reading)return;
 reading=true;const token=revision;lock();
 notice(feedback,'Reading the agent vault…','busy');
 try{const reply=await api('/api/agent/state');if(token!==revision)return;if(!reply.ok)throw Error(reply.error);render(reply.state);notice(feedback,'Agent vault refreshed','success');}
 catch(error){if(token===revision)notice(feedback,'Could not read the agent vault','danger',error.message);}
 finally{reading=false;lock();}
}
async function mutate(path,body,message){
 if(busy)return;revision++;busy=true;lock();notice(feedback,message,'busy');
 try{
  const reply=await api(path,body);if(!reply.ok)throw Error(reply.error);
  render(reply.state);
  if(path.endsWith('/import'))$('#agent-import-form').reset();
  const [label,tone]=labels[reply.record.outcome]??['Pending','warning'];
  notice(feedback,reply.already_imported?'Already imported':path.endsWith('/import')?'Signed bill imported':label,
   reply.already_imported?'info':tone,reply.already_imported?'The existing bill and its payment record are unchanged.':reply.record.error??reply.record.id);
 }catch(error){notice(feedback,'Request could not be completed','danger',error.message);}
 finally{busy=false;lock();}
}
$('#agent-refresh').addEventListener('click',refreshAgentPayments);
$('#agent-bill-file').addEventListener('change',async event=>{
 const file=event.target.files?.[0];if(!file)return;
 if(file.size>16384){notice(feedback,'Signed bill is too large','danger','Choose a JSON file no larger than 16 KB.');return;}
 try{$('#agent-bill-json').value=await file.text();}
 catch{notice(feedback,'Could not read the file','danger');}
});
$('#agent-import-form').addEventListener('submit',event=>{
 event.preventDefault();if(busy)return;
 try{
  const invoice=JSON.parse($('#agent-bill-json').value);
  if(new TextEncoder().encode(JSON.stringify({invoice})).byteLength>16384)throw Error('Request too large. Maximum 16 KB including the JSON wrapper.');
  mutate('/api/agent/import',{invoice},'Checking the supplier’s signature…');
 }catch(error){notice(feedback,'Check the signed bill','danger',error instanceof SyntaxError?'Paste a valid signed invoice JSON object.':error.message);}
});
