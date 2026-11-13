import {weeklySteps,weeklyFrame} from './model.js';
const $=id=>document.getElementById(id);
const el=(tag,text,className='')=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n;};
const link=(text,url)=>{const n=el('a',text);n.href=url;n.target='_blank';n.rel='noopener noreferrer';return n;};
let evidence,scenario='weekly',index=0;
function field(name,value){$('receipt-fields').append(el('dt',name),el('dd',value));}
function render(){
 const weekly=scenario==='weekly',w=evidence.weekly,steps=weekly?weeklySteps:evidence.cafe.cases.map(c=>c.title);
 $('choose-weekly').setAttribute('aria-pressed',String(weekly));$('choose-cafe').setAttribute('aria-pressed',String(!weekly));
 $('recording-context').textContent=weekly?`Local test-chain recording · service week starting ${w.week} UTC · ${w.service.agreement_id}`:`Separate public-testnet recording · ${new Date(evidence.cafe.recordedAt).toISOString().slice(0,10)} · zero live model calls`;
 $('steps').className='steps'+(weekly?'':' cafe-steps');$('steps').replaceChildren();
 steps.forEach((title,i)=>{const item=el('li',''),button=el('button','');button.append(el('span',String(i+1).padStart(2,'0')),el('strong',title));if(index===i)button.setAttribute('aria-current','step');button.addEventListener('click',()=>{index=i;render();$('steps').children[i].children[0].focus({preventScroll:true});});item.append(button);$('steps').append(item);});
 $('bills').replaceChildren();$('receipt-fields').replaceChildren();
 $('checkpoint').textContent=weekly?'SAVED CHECKPOINT / '+String(index+1).padStart(2,'0'):'RECORDED TESTNET CASE / '+String(index+1).padStart(2,'0');
 $('previous').disabled=index===0;$('next').disabled=index===steps.length-1;
 $('next').textContent=weekly?'Next checkpoint →':'Next case →';$('position').textContent=`${index+1} / ${steps.length}`;
 if(weekly){
  const frame=weeklyFrame(evidence,index);
  $('scene-title').textContent=frame.title;$('scene-description').textContent=frame.description;
  for(const b of frame.bills){const card=el('div','','bill');card.append(el('p',b.bill),el('strong',b.invoice),el('strong',w.amount+' NEAR','bill-amount'),el('span',b.state,'badge '+b.state.toLowerCase()));$('bills').append(card);}
  $('worker').textContent='Worker: '+frame.worker;
  $('received').textContent=frame.balance.received;$('amount-context').textContent='Total credited during the recorded weekly race.';
  $('ledger-label').textContent='Vault available';$('available').textContent=frame.balance.available+' NEAR';$('retry').textContent=frame.extra===null?'Not replayed yet':frame.extra+' NEAR';$('network').textContent='Local test chain';
  field('Recorded block',String(frame.balance.block));field('Vault',w.vault);field('Payee',w.payee);field('Service week',w.week+' UTC');
  if(frame.attempt){field('Original attempt',frame.attempt);field('Winning invoice',w.winner);field('Commitment',w.receipt.payment.commitment);field('Signed payload hash',w.receipt.auth.payload_hash);}
  $('receipt-link').href='./evidence/weekly.json';$('receipt-link').textContent='Open original local run ↗';
 }else{
  const c=evidence.cafe.cases[index];
  $('scene-title').textContent=c.title;$('scene-description').textContent=c.explanation;
  const card=el('div','','bill');card.append(el('p','RECORDED INVOICE'),el('strong',c.invoice.id),el('strong',c.amount+' NEAR','bill-amount'),el('span',c.state,'badge '+c.state.toLowerCase()));$('bills').append(card);
  $('worker').textContent='Recorded result: '+c.reason;
  $('received').textContent=c.credited;$('amount-context').textContent='Credit from this individual historical testnet case.';
  $('ledger-label').textContent='Recorded outcome';$('available').textContent=c.state;$('retry').textContent=c.retry===null?'No transfer':c.retry+' NEAR';$('network').textContent='NEAR testnet';
  field('Invoice',c.invoice.id);field('Payee on submitted bill',c.invoice.payee);field('Vault',evidence.cafe.vault);field('Transaction',c.transaction.hash);
  if(c.payment){field('Original attempt',c.payment.attempt_id);field('Commitment',c.payment.commitment);}
  if(c.reserve)field('Reservation transaction',c.reserve.hash);if(c.replay)field('Retry transaction',c.replay.hash);
  $('receipt-link').href=c.transaction.link;$('receipt-link').textContent='View historical transaction ↗';
 }
}
function choose(value){scenario=value;index=0;render();}
$('choose-weekly').addEventListener('click',()=>choose('weekly'));
$('choose-cafe').addEventListener('click',()=>choose('cafe'));
$('previous').addEventListener('click',()=>{if(index>0){index--;render();}});
$('next').addEventListener('click',()=>{if(index<(scenario==='weekly'?4:evidence.cafe.cases.length)-1){index++;render();}});
try{
 const response=await fetch('./evidence.json');if(!response.ok)throw Error('Recorded data unavailable');evidence=await response.json();
 if(evidence.mode!=='RECORDED_DEMO'||evidence.newPayments!==false||evidence.cafe.cases.length!==5)throw Error('Invalid recording');
 render();
 $('verification-date').textContent='Transaction statuses checked against public NEAR RPC on '+new Date(evidence.verification.checked_at).toISOString().slice(0,10)+'.';
 for(const c of evidence.cafe.cases){const row=el('div','','transaction');row.append(el('strong',c.title),el('p',c.reason),link(c.state+' · receipt ↗',c.transaction.link));$('transactions').append(row);}
 const sha=evidence.provenance.commit;
 $('source-revision').append(el('span','Built from repository revision '),link(sha.slice(0,7),`https://github.com/Pradeeppilotdev/countersign/tree/${sha}`));
 for(const s of evidence.provenance.sources){const item=el('li','');item.append(link(s.path,`https://github.com/Pradeeppilotdev/countersign/blob/${sha}/${s.path}`),el('div','SHA-256: '+s.sha256));$('source-hashes').append(item);}
 $('hero-paid').textContent=evidence.weekly.final.received;
 $('hero-caption').textContent='One service week. One settled payment.';
 $('hero-bills').textContent=String(evidence.weekly.bills.length).padStart(2,'0');
 $('hero-extra').textContent=weeklyFrame(evidence,3).extra+' NEAR';
 $('hero-stamp').hidden=false;
 $('replay-content').hidden=false;$('choose-weekly').disabled=false;$('choose-cafe').disabled=false;
}catch{
 $('hero-caption').textContent='Saved result unavailable. Read the original evidence below.';
 $('hero-stamp').hidden=true;
 $('replay-content').hidden=true;$('load-error').hidden=false;
}finally{$('loading').hidden=true;}
