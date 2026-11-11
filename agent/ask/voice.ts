// A reply can use conversational phrasing, but every factual clause must match
// a complete claim about one selected record. Matching isolated words/numbers
// cannot establish which amount, outcome or reason belongs to which subject.
import type {FactsPack} from './facts.ts';
import {GLOSSARY} from './glossary.ts';

const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const clean=(text:string)=>text.replace(/’/g,"'").trim().replace(/[.!?]+$/,'');
const literal=(text:string)=>escape(clean(text));
const words=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
const count=(n:number)=>`(?:${n}${words[n]?'|'+words[n]:''})`;

// These are conversational clauses, not assessments such as "everything is fine"
// or promises that a payment will succeed. A model can combine them freely.
const friendly=[
 '(?:hi|hey|hello)(?: Dave)?', 'thanks(?: for asking)?', "you're welcome", 'happy to help',
 "(?:I'm |I am )?doing (?:well|great)", 'all good here',
 "here(?:'s| is) what (?:I found|the records show)",
 "(?:I'm |I am )?here to help(?: with (?:your vault|your bills|your payments))?",
 "(?:want|would you like) a summary of your agent's payments",
 "let me know if you want a summary of your agent's payments",
 "I'm keeping an eye on it with you", 'ask me anything about your vault',
 "I'm here whenever you want to check on your vault",
 'just ask about (?:your )?(?:bills|payments|rules)(?:, (?:payments|rules))?(?:,? or (?:rules|your vault))?',
];

type Options={patterns:string[];examples:string[]};
export function voiceOptions(pack:FactsPack,key:string,text:string):Options{
 const options:Options={patterns:[literal(text)],examples:[]};
 const add=(pattern:string,example:string)=>{options.patterns.push(pattern);options.examples.push(example);};
 if(key.startsWith('invoice:')){
  const bill=pack.invoices.find(b=>key==='invoice:'+b.id);
  if(!bill)return options;
  const id=`(?:${escape(bill.id)}|\\[${escape(bill.id)}\\])`;
  // Do not turn an unattributed chain transfer into a verified supplier payment.
  if(bill.outcome==='paid'&&bill.attribution!=='verified')return options;
  const state=bill.outcome==='paid'?'(?:paid|settled)':bill.outcome==='blocked'?'(?:blocked|rejected)':escape(bill.outcome);
  add(`(?:invoice |bill )?${id} (?:is|was|has been) ${state}`,`${bill.id} was ${bill.outcome}`);
  if(bill.amount_near!==null){
   const amount=escape(bill.amount_near);
   add(`(?:invoice |bill )?${id} (?:is|was) (?:for )?${amount} NEAR`,`${bill.id} is for ${bill.amount_near} NEAR`);
   if(bill.outcome==='paid')add(`${id} (?:was|has been) (?:paid|settled) (?:for )?${amount} NEAR(?: once)?`,`${bill.id} was paid ${bill.amount_near} NEAR once`);
  }
  if(bill.explanation){
   // The ID remains attached to the whole reason. A different invoice's cause
   // cannot be borrowed, even if both invoices were selected.
   add(`(?:for ${id}, |${id}: )${literal(bill.explanation.meaning)}`,`${bill.id}: ${clean(bill.explanation.meaning)}`);
   add(`(?:for ${id}, |${id}: )${literal(bill.explanation.what_to_do)}`,`For ${bill.id}, ${clean(bill.explanation.what_to_do)}`);
   const reasons:Record<string,string>={
    'rolling daily budget exceeded':'paying it would (?:have gone over|go over|exceed|push your last 24 hours of spending over) your (?:rolling )?daily budget',
    'per-payment cap exceeded':'(?:the (?:bill|amount) (?:was|is) over your per-payment (?:cap|limit)|it exceeded your per-payment (?:cap|limit))',
    'invalid merchant signature':'the supplier signature was invalid',
    'merchant bill already used':'this supplier bill was already registered under another invoice (?:ID|number)',
    'service period already claimed by':'another invoice already claimed (?:this|the same) service week',
   };
   for(const [reason,pattern] of Object.entries(reasons)){
    if(bill.explanation.meaning===GLOSSARY[reason].meaning)
     options.patterns.push(`${id} (?:was|is) ${state} because ${pattern}`);
   }
  }
 }
 if(key==='budget'){
  const rules=pack.vault.rules,day=pack.totals.per_day;
  if(rules?.expired===false)add('(?:your |the )?(?:spending )?policy (?:is active|has not expired)', 'Your spending policy is active');
  if(rules?.expired===true)add('(?:your |the )?(?:spending )?policy (?:has expired|is expired|is inactive)', 'Your spending policy has expired');
  if(rules?.per_payment_near!=null)add(`(?:your |the )?per-payment (?:cap|limit) is ${escape(rules.per_payment_near)} NEAR`,`Your per-payment cap is ${rules.per_payment_near} NEAR`);
  if(day.limit_near!==null)add(`(?:your |the )?(?:rolling (?:24-hour |daily )?|daily )budget is ${escape(day.limit_near)} NEAR`,`Your rolling daily budget is ${day.limit_near} NEAR`);
  if(day.remaining_near!==null){
   const remaining=escape(day.remaining_near);
   add(`(?:you have )?${remaining} NEAR (?:left|remaining)(?: (?:today|in your rolling (?:24-hour|daily) budget))?`,`You have ${day.remaining_near} NEAR left in your rolling daily budget`);
   add(`(?:your |the )?(?:remaining (?:rolling )?(?:daily )?budget|(?:rolling )?(?:daily )?budget remaining) is ${remaining} NEAR`,`Your remaining daily budget is ${day.remaining_near} NEAR`);
  }
  if(day.used_near!==null)add(`(?:you have used|you've used) ${escape(day.used_near)} NEAR (?:in the last 24 hours|of your rolling daily budget)`,`You have used ${day.used_near} NEAR in the last 24 hours`);
 }
 if(key==='balance'&&pack.vault.available_near!==null)add(`(?:your |the )?vault has ${escape(pack.vault.available_near)} NEAR available`,`Your vault has ${pack.vault.available_near} NEAR available`);
 if(key==='pause'&&typeof pack.vault.controls?.paused==='boolean'){
  const paused=pack.vault.controls.paused;
  add(`(?:(?:your |the )?vault is|payments are) ${paused?'paused':'(?:not paused|unpaused)'}`,`Payments are ${paused?'':'not '}paused`);
 }
 if(key==='activity'){
  for(const [outcome,n] of Object.entries(pack.totals.counts)){
   add(`${count(n)}(?: (?:bills?|invoices?|payments?))? (?:was|were|is|are|have been|has been) ${escape(outcome)}`,`${n} ${n===1?'bill was':'bills were'} ${outcome}`);
  }
  const proposed=pack.invoices.filter(b=>b.agent.has_proposal).length;
  add(`(?:your |the )?agent (?:recorded|logged) proposals for ${count(proposed)}(?: of (?:the )?${count(pack.invoices.length)} bills in (?:the |your )?inbox)?`,`Your agent recorded proposals for ${proposed} of ${pack.invoices.length} bills in the inbox`);
  if(pack.totals.counts.queued+pack.totals.counts.proposed+pack.totals.counts.pending===0)
   add('(?:nothing is waiting|no bills are waiting)','Nothing is waiting');
 }
 return options;
}

// Only additive/contrastive joins are allowed between independent true clauses.
// Causal statements (because/so/if) must match a whole, invoice-bound claim.
function composed(text:string,patterns:string[]):boolean{
 const value=clean(text),failed=new Set<number>();
 const atoms=patterns.map(pattern=>new RegExp(`^(?:${pattern})(?=$|[\\s,.!?;:—–])`,'iu'));
 const separator=/^(?:[.!?;]\s*|,\s*(?:(?:and|with|but)\s+)?|\s+(?:and|with|but)\s+|\s*[—–:]\s+|\n+)/i;
 function from(offset:number):boolean{
  if(offset===value.length)return true;
  if(failed.has(offset))return false;
  const rest=value.slice(offset);
  for(const atom of atoms){
   const match=atom.exec(rest);if(!match?.[0])continue;
   const end=offset+match[0].length;
   if(end===value.length)return true;
   const join=separator.exec(value.slice(end));
   if(join&&from(end+join[0].length))return true;
  }
  failed.add(offset);return false;
 }
 return from(0);
}
export function groundedReply(pack:FactsPack,selected:{key:string;text:string}[],reply:string):boolean{
 // English is case-insensitive; identifiers are not.
 for(const bill of pack.invoices){
  for(const m of reply.matchAll(new RegExp(`(?<![A-Za-z0-9_.:-])${escape(bill.id)}(?![A-Za-z0-9_-])`,'gi')))
   if(m[0]!==bill.id)return false;
 }
 return composed(reply,[...friendly,...selected.flatMap(e=>voiceOptions(pack,e.key,e.text).patterns)]);
}
export const conversationalReply=(reply:string)=>composed(reply,friendly);
