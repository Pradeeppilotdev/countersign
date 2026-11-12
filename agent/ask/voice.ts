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
 '(?:hi|hey|hello)(?: there| Dave)?', 'thanks(?: for asking)?', '(?:good|great) question', 'sure', "you're welcome", 'happy to help',
 "(?:I'm |I am )?doing (?:well|great)", 'all good here',
 "here(?:'s| is) what (?:I found|the records show)",
 "(?:I'm |I am )?here to help(?: with (?:your vault|your bills|your payments))?",
 "(?:want|would you like) a summary of your agent's payments",
 "let me know if you want a summary of your agent's payments",
 "I'm keeping an eye on it with you", 'ask me anything about your vault',
 "I'm here whenever you want to check on your vault",
 'just ask about (?:your )?(?:bills|payments|rules)(?:, (?:payments|rules))?(?:,? or (?:rules|your vault|anything else))?',
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
   // [pattern, phrasing example]. The example is listed in reply_examples so the model can see the accepted form.
   const reasons:Record<string,[string,string]>={
    'rolling daily budget exceeded':['paying it would (?:have gone over|go over|exceed|push your last 24 hours of spending over) your (?:rolling )?daily budget','paying it would go over your rolling daily budget'],
    'per-payment cap exceeded':['(?:the (?:bill|amount) (?:was|is) over your per-payment (?:cap|limit)|it exceeded your per-payment (?:cap|limit))','the amount is over your per-payment limit'],
    'invalid merchant signature':['the supplier signature was invalid','the supplier signature was invalid'],
    'merchant bill already used':['this supplier bill was already registered under another invoice (?:ID|number)','this supplier bill was already registered under another invoice number'],
    'service period already claimed by':['another invoice already claimed (?:this|the same) service week','another invoice already claimed this service week'],
   };
   for(const [reason,[pattern,example]] of Object.entries(reasons)){
    if(bill.explanation.meaning===GLOSSARY[reason].meaning)
     add(`${id} (?:was|is) ${state} because ${pattern}`,`${bill.id} was ${bill.outcome} because ${example}`);
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
// ---- Claim-based verification ----
// A sentence that does not match a whole phrase pattern is still accepted when
// every claim in it checks out against the selected evidence: invoice IDs,
// amounts, counts, outcome words, pause and policy state, and glossary reasons.
// Everything else in the sentence must be plain connective or friendly wording
// from a fixed vocabulary, so an unchecked assessment ("fine", "safe"), a cause,
// a promise or an action ("sent", "approved") still drops the reply.
type Bill=FactsPack['invoices'][number];
const VOCAB=new Set(`a an the this that these those it its it's they them their there there's here here's is are was were be been being has have had do does did
 i i'm i've you you've you're your yours we we've our us me my dave hi hey hello thanks thank sure please yes no of in on at for to from with and but or also as by
 about just only still yet already currently right now today moment total overall altogether all both each other others rest remaining left out bill bills invoice
 invoices payment payments agent agent's vault vault's inbox supplier suppliers record records recorded show shows found what what's which how want would like let
 one know ask anything else help happy glad summary details check look quick update overview below see breakdown status state outcome outcomes number count once proposal proposals got`.split(/\s+/));
const BUDGET_VOCAB=new Set('near policy spending per-payment cap limit rolling daily budget used available balance holds hold funds day amount single maximum'.split(' '));
const WORD_NUMBERS:Record<string,number>={zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12};
const OUTCOME_TOKEN:Record<string,string>={paid:'paid',settled:'paid',blocked:'blocked',rejected:'blocked',failed:'failed',queued:'queued',proposed:'proposed',pending:'pending',
 waiting:'waiting',outstanding:'waiting','~waiting':'waiting',unpaid:'unpaid','~unpaid':'unpaid',cancelled:'cancelled',canceled:'cancelled',refunded:'refunded'};
const WAITING=['queued','proposed','pending'];
const billAllows:Record<string,(b:Bill)=>boolean>={
 paid:b=>b.outcome==='paid'&&b.attribution==='verified',blocked:b=>b.outcome==='blocked',failed:b=>b.outcome==='failed',
 queued:b=>b.outcome==='queued',proposed:b=>b.outcome==='proposed',pending:b=>WAITING.includes(b.outcome),waiting:b=>WAITING.includes(b.outcome),
 unpaid:b=>b.outcome!=='paid',cancelled:b=>b.outcome==='cancelled',refunded:()=>false,
};
const negates=(t:string|undefined)=>t!==undefined&&(t==='not'||t==='never'||t==='no'||t==='none'||t==='nothing'||t.endsWith("n't"));
const lower=(t:string)=>t.replace(/[’‘]/g,"'").toLowerCase();

// Glossary text for a selected bill, located in the reply (case-insensitive). A
// reason may span two sentences, so these ranges are never split.
function glossarySpans(pack:FactsPack,keys:string[],reply:string){
 const spans:{from:number;to:number;bill:number;kind:'m'|'w'}[]=[],text=lower(reply);
 pack.invoices.forEach((bill,index)=>{
  if(!bill.explanation||!keys.includes('invoice:'+bill.id))return;
  for(const kind of ['m','w'] as const){
   const phrase=lower(clean(kind==='m'?bill.explanation.meaning:bill.explanation.what_to_do));
   for(let at=text.indexOf(phrase);at>=0;at=text.indexOf(phrase,at+1))spans.push({from:at,to:at+phrase.length,bill:index,kind});
  }
 });
 return spans.sort((a,b)=>a.from-b.from||b.to-a.to).filter((s,i,all)=>!all.slice(0,i).some(o=>s.from<o.to));
}
function sentencesOf(reply:string,spans:{from:number;to:number}[]){
 const out:{from:number;to:number}[]=[];let from=0;
 for(const m of reply.matchAll(/[.!?;]+(?=\s|$)\s*|\n+/g)){
  const at=m.index!;if(spans.some(s=>at>=s.from&&at<s.to))continue;
  out.push({from,to:at});from=at+m[0].length;
 }
 out.push({from,to:reply.length});
 return out.filter(s=>reply.slice(s.from,s.to).trim());
}

function claimsHold(pack:FactsPack,keys:string[],sentence:string,spans:{from:number;to:number;bill:number;kind:'m'|'w'}[],offset:number,inherited:number[]):{ok:boolean;ids:number[]}{
 const fail={ok:false,ids:[] as number[]};
 // Placeholders: §iN an invoice, §mN / §wN its glossary meaning / next step.
 let text='',at=0;
 for(const s of spans.filter(s=>s.from>=offset&&s.to<=offset+sentence.length)){text+=sentence.slice(at,s.from-offset)+` §${s.kind}${s.bill} `;at=s.to-offset;}
 text+=sentence.slice(at);
 const ids:number[]=[];
 pack.invoices.forEach((bill,index)=>{
  text=text.replace(new RegExp(`(?<![A-Za-z0-9_.:-])\\[?${escape(bill.id)}\\]?(?![A-Za-z0-9_-])`,'g'),()=>{ids.push(index);return ` §i${index} `;});
 });
 if(/\b[A-Z]{2,}-[A-Z0-9-]*[A-Z0-9]\b/.test(text))return fail;                       // an invoice-like ID that is not in this vault
 if(ids.some(i=>!keys.includes('invoice:'+pack.invoices[i].id)))return fail;          // a real invoice that was not selected
 const subjects=ids.length?[...new Set(ids)]:inherited;
 const budget=keys.includes('budget'),balance=keys.includes('balance'),activity=keys.includes('activity');
 text=lower(text)
  .replace(/\b(?:in the |over the )?(?:last |past )?24(?:[- ]hours?|h)\b/g,' ').replace(/\bso far\b/g,' ').replace(/\bin total\b/g,' total ')
  .replace(/\b(?:still |yet )?waiting to be paid\b|\b(?:still |yet )to be paid\b|\bawaiting payment\b/g,' ~waiting ')
  .replace(/\b(?:not (?:yet )?paid(?: yet)?|(?:has|have)(?:n't| not)(?: yet)? been paid(?: yet)?)\b/g,' ~unpaid ');
 const merchants=new Set(subjects.map(i=>lower(pack.invoices[i].merchant)));
 const day=pack.totals.per_day,rules=pack.vault.rules,c=pack.totals.counts;
 const waiting=c.queued+c.proposed+c.pending;
 const bucket:Record<string,number[]>={paid:[c.paid],blocked:[c.blocked+c.failed,c.blocked],failed:[c.failed],queued:[c.queued],proposed:[c.proposed],
  pending:[waiting,c.pending],waiting:[waiting],unpaid:[waiting],cancelled:[c.cancelled],refunded:[]};
 let sentenceCount:number|null=null;                                // a count earlier in the sentence covers later outcome words
 const clauses=text.split(/[,:—–()]|\s(?:and|but|with|while|plus)\s/);
 for(const clause of clauses){
  const tokens=clause.match(/§[imw]\d+|\d+(?:\.\d+)?|~\w+|[a-z0-9]+(?:[-'][a-z0-9]+)*/g)??[];
  if(!tokens.length)continue;
  if(new RegExp(`^(?:${friendly.join('|')})$`,'i').test(clause.trim().replace(/[.!?]+$/,'')))continue;
  const used=new Set<number>();
  const idAt=(i:number)=>{                                            // the bill a claim at token i is about
   for(let j=i-1;j>=0;j--)if(tokens[j].startsWith('§i'))return Number(tokens[j].slice(2));
   for(let j=i+1;j<tokens.length;j++)if(tokens[j].startsWith('§i'))return Number(tokens[j].slice(2));
   return ids.length?ids[ids.length-1]:null;
  };
  const hasId=tokens.some(t=>t.startsWith('§i'));
  const outcomeIdx=tokens.map((t,i)=>OUTCOME_TOKEN[t]?i:-1).filter(i=>i>=0);
  const outcomeNear=(i:number)=>{const after=outcomeIdx.find(j=>j>i);return OUTCOME_TOKEN[tokens[after??outcomeIdx.filter(j=>j<i).pop()!]];};
  const isCount=(w:string,j:number)=>/^\d+$/.test(w)&&tokens[j+1]!=='near'||WORD_NUMBERS[w]!==undefined&&!(w==='one'&&['this','that','the','which','each'].includes(tokens[j-1]))||['no','none','nothing'].includes(w);
  for(let i=0;i<tokens.length;i++){
   const t=tokens[i];
   if(t.startsWith('§i')){used.add(i);continue;}
   if(t.startsWith('§m')||t.startsWith('§w')){
    if(!subjects.includes(Number(t.slice(2))))return fail;           // a reason borrowed from another invoice
    used.add(i);continue;
   }
   if(t==='because'){
    const next=tokens[i+1];
    if(!next?.startsWith('§m')||idAt(i)!==Number(next.slice(2)))return fail;
    used.add(i);continue;
   }
   const value=/^\d+(?:\.\d+)?$/.test(t)?t:null;
   if(value!==null&&tokens[i+1]==='near'){                            // an amount, bound to its invoice or budget field
    used.add(i);used.add(i+1);
    const bill=hasId||ids.length?idAt(i):null;
    if(bill!==null){if(pack.invoices[bill].amount_near===null||Number(pack.invoices[bill].amount_near)!==Number(value))return fail;continue;}
    const near=(words:string[])=>{let best:string|null=null,dist=Infinity;tokens.forEach((w,j)=>{if(words.includes(w)&&Math.abs(j-i)<dist){best=w;dist=Math.abs(j-i);}});return best as string|null;};
    const field=near(['used','remaining','left'])??near(['per-payment','cap','single','available','holds','hold','balance','budget','limit','daily','rolling']);
    const expected=field===null?null:field==='used'?(budget?day.used_near:null):field==='remaining'||field==='left'?(budget?day.remaining_near:null)
     :['per-payment','cap','single'].includes(field)?(budget?rules?.per_payment_near??null:null):['available','holds','hold','balance'].includes(field)?(balance?pack.vault.available_near:null)
     :(budget?day.limit_near:null);
    if(expected===null||Number(expected)!==Number(value))return fail;
    continue;
   }
   const word=WORD_NUMBERS[t]!==undefined&&!(t==='one'&&['this','that','the','which','each'].includes(tokens[i-1]))?WORD_NUMBERS[t]:null;
   const zero=['no','none','nothing'].includes(t)&&!hasId&&outcomeIdx.length?0:null;
   if(value!==null||word!==null||zero!==null){                        // a count, checked against the activity totals
    if(value!==null&&value.includes('.'))return fail;
    if(!activity)return fail;
    const n=value!==null?Number(value):word??zero!;
    const ofTotal=tokens[i-1]==='of'||(['your','the','all'].includes(tokens[i-1])&&tokens[i-2]==='of')||tokens[i+1]==='total'||tokens[i-1]==='total';
    let allowed:number[];
    if(ofTotal)allowed=[pack.invoices.length];
    else if(tokens.includes('proposals')||tokens.includes('proposal'))allowed=[pack.invoices.filter(b=>b.agent.has_proposal).length];
    else if(outcomeIdx.length)allowed=bucket[outcomeNear(i)];
    else if(tokens.some(w=>['bill','bills','invoice','invoices','payment','payments'].includes(w)))allowed=[pack.invoices.length];
    else return fail;
    if(!allowed.includes(n))return fail;
    if(!ofTotal)sentenceCount=n;
    used.add(i);continue;
   }
   if(OUTCOME_TOKEN[t]){                                              // an outcome word: about an invoice, or part of a count
    used.add(i);
    const outcome=OUTCOME_TOKEN[t];
    const negated=negates(tokens[i-1])||negates(tokens[i-2])&&['been','yet','be'].includes(tokens[i-1]);
    if(!hasId&&tokens.some(isCount))continue;                         // the count beside it is checked against this outcome
    if(!hasId&&!negated&&sentenceCount!==null&&bucket[outcome].includes(sentenceCount))continue;  // "12 are queued and waiting"
    const bill=hasId||ids.length?idAt(i):null;
    if(bill===null||billAllows[outcome](pack.invoices[bill])===negated)return fail;
    continue;
   }
   if(/^(?:un)?paus(?:e|ed)$/.test(t)){                                // pause state
    const paused=pack.vault.controls?.paused;
    if(!keys.includes('pause')||typeof paused!=='boolean')return fail;
    const claim=t==='unpaused'?false:t==='paused'?!negates(tokens[i-1]):tokens.includes('on')?true:tokens.includes('off')?false:null;
    if(claim===null||claim!==paused)return fail;
    used.add(i);tokens.forEach((w,j)=>{if(w==='on'||w==='off')used.add(j);});continue;
   }
   if(/^(?:active|inactive|expired?|expires|expiring)$/.test(t)){       // policy state
    if(!budget||typeof rules?.expired!=='boolean')return fail;
    const claim=(t!=='active')!==(negates(tokens[i-1])||negates(tokens[i-2]));
    if(t==='expire'||t==='expires'||t==='expiring'||claim!==rules.expired)return fail;
    used.add(i);continue;
   }
  }
  for(let i=0;i<tokens.length;i++){
   if(used.has(i))continue;
   const t=tokens[i];
   if(VOCAB.has(t)||merchants.has(t)||negates(t)&&tokens.slice(i+1).some(w=>OUTCOME_TOKEN[w]||/^(?:un)?paus|^(?:active|expired)$/.test(w)))continue;
   if((budget||balance)&&BUDGET_VOCAB.has(t))continue;
   return fail;
  }
 }
 return {ok:true,ids:ids.length?[...new Set(ids)]:inherited};
}

// voice: patterns that a code-computed record (help cards, what fits) supplies for itself.
export function groundedReply(pack:FactsPack,selected:{key:string;text:string;voice?:{patterns:string[]}}[],reply:string):boolean{
 // English is case-insensitive; identifiers are not.
 for(const bill of pack.invoices){
  for(const m of reply.matchAll(new RegExp(`(?<![A-Za-z0-9_.:-])${escape(bill.id)}(?![A-Za-z0-9_-])`,'gi')))
   if(m[0]!==bill.id)return false;
 }
 const patterns=[...friendly,...selected.flatMap(e=>[...voiceOptions(pack,e.key,e.text).patterns,...e.voice?.patterns??[]])];
 if(composed(reply,patterns))return true;
 const keys=selected.map(e=>e.key),text=reply.replace(/’/g,"'");
 const spans=glossarySpans(pack,keys,text);
 let inherited:number[]=[];
 for(const {from,to} of sentencesOf(text,spans)){
  const sentence=text.slice(from,to);
  if(composed(sentence,patterns)){
   const named=pack.invoices.map((b,i)=>sentence.includes(b.id)?i:-1).filter(i=>i>=0);
   if(named.length)inherited=named;
   continue;
  }
  const result=claimsHold(pack,keys,sentence,spans,from,inherited);
  if(!result.ok)return false;
  inherited=result.ids;
 }
 return true;
}
