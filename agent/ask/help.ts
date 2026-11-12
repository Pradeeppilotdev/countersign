// Ask Dave how-to cards and the "what fits" fact. Fixed, code-written text.
// Cards only DESCRIBE commands; nothing in agent/ask runs them. Each command is
// the exact form from the agent:desk usage string (agent/ask.test.ts checks this).
// "What fits" is exact BigInt arithmetic on yocto values from the facts pack: the
// model selects it and never does the maths.
import {formatNear,type FactsPack} from './facts.ts';

export type Voice={patterns:string[];examples:string[]};
const escape=(text:string)=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const DESK='npm run agent:desk -- ';
const command=(usage:string)=>`(?:\`)?${escape(DESK+usage)}(?:\`)?`;

type Card={topic:string;goals:string[];text:string;usages:string[];website:string|null};
// goals: how an owner might name the task, as regex alternatives; the first is the phrasing example.
export const HELP:readonly Card[]=Object.freeze([
 {topic:'policy',goals:['change your per-payment limit, rolling budget or minimum payment','change (?:your )?(?:per-payment|per-transaction|per txn|per payment) (?:limit|cap)','change (?:your )?(?:rolling |24-hour |daily )*budget','change (?:your )?minimum(?: payment)?','change (?:your )?(?:spending )?(?:policy|rules|limits)'],
  text:'Set new spending rules with the policy command: the per-payment limit and rolling 24-hour budget in NEAR, how many minutes the policy lasts, and an optional minimum payment.',
  usages:['policy <per-payment NEAR> <rolling NEAR> <minutes> [minimum NEAR]'],website:null},
 {topic:'renew',goals:['renew an expired policy','renew (?:an expired |your |the )?(?:spending )?policy','extend (?:your |the )?(?:spending )?policy'],
  text:'Renew your spending policy with renew-policy: give how many minutes it should last and a renewal ID you choose. A renewal can extend it by at most 30 days.',
  usages:['renew-policy <minutes> <renewal-id>'],website:null},
 {topic:'pause',goals:['pause or unpause payments','pause (?:agent |all |your )?payments','unpause (?:agent |all |your )?payments','stop (?:agent |all )?payments'],
  text:'Pause stops every agent payment until you unpause.',
  usages:['pause','unpause'],website:null},
 {topic:'supplier-key',goals:['add or remove a supplier signing key','add (?:a |your )?supplier(?: signing)? key','pin (?:a |your )?supplier(?: signing)? key','remove (?:a |your )?supplier(?: signing)? key','revoke (?:a |your )?supplier(?: signing)? key'],
  text:'Pin a supplier\'s signing key so the vault only accepts bills that supplier signed. Revoke it to stop accepting their signatures.',
  usages:['merchant-key <merchant> <base64 public key>','revoke-key <merchant>'],website:null},
 {topic:'import-bill',goals:['import a signed bill','import a signed (?:bill|invoice)','import your signed (?:bill|invoice)','import signed (?:bill|invoice)','add (?:a |your )?(?:signed )?(?:bill|invoice)'],
  text:'Import a supplier\'s signed JSON bill. The vault checks the signature before saving it.',
  usages:['import <signed-invoice.json>'],website:'Agent payments → Import signed bill'},
 {topic:'resume',goals:['resume a saved bill','resume (?:a |the |your )?(?:saved |stuck )?(?:bill|invoice|payment)','retry (?:a |the |your )?(?:bill|invoice|payment)'],
  text:'Resume a saved bill once you have fixed what stopped it. If the AI did not return a usable proposal for a bill, retry the proposal first, then run the bill again.',
  usages:['resume [id]','retry-proposal <id>','run <id> [--live-model]'],website:'Agent payments → Resume on the bill'},
 {topic:'cancel',goals:['cancel a bill','cancel (?:a |the |your )?(?:bill|invoice|payment)'],
  text:'Cancel a bill you no longer want your agent to pay.',
  usages:['cancel <id>'],website:null},
 {topic:'capacity',goals:['check your spending capacity','check (?:your )?(?:spending )?(?:capacity|allowance)','see (?:your )?(?:spending )?(?:capacity|allowance)'],
  text:'The capacity command shows your minimum payment, how many unfinished and total payments the vault can hold, and the allowance already charged.',
  usages:['capacity'],website:null},
]);

export function helpEvidence(){
 return HELP.map(card=>{
  const commands=card.usages.map(u=>'`'+DESK+u+'`').join(' or ');
  const where=card.website?` On the website: ${card.website}.`:' This is CLI-only.';
  const text=`${card.text} Command: ${commands}.${where}`;
  const patterns=[escape(text.replace(/[.]$/,'')),...sentences(card.text).map(escape)],examples:string[]=[];
  const add=(pattern:string,example:string)=>{patterns.push(pattern);examples.push(example);};
  const goal=`(?:${card.goals.map((g,i)=>i===0?escape(g):g).join('|')})`;
  for(const usage of card.usages)add(`(?:to ${goal},? |you can ${goal} with )?(?:run|use)(?: the command)? ${command(usage)}`,`To ${card.goals[0]}, run ${DESK+usage}`);
  if(card.website)add(`(?:on|in) the website,? (?:go to |open |use )?${escape(card.website)}`,`On the website, go to ${card.website}`);
  else add('(?:this|it) is (?:CLI-only|only available (?:from|in) the CLI)|there is no website (?:button|option) for (?:this|it)','This is CLI-only');
  return {key:'help:'+card.topic,text,voice:{patterns,examples} as Voice};
 });
}
function sentences(text:string){return text.split(/(?<=[.])\s+/).map(s=>s.replace(/[.]$/,''));}

// ---- What fits ----
const YOCTO=10n**24n;
const digits=(v:unknown):v is string=>typeof v==='string'&&/^[0-9]{1,39}$/.test(v);
type QuestionAmount={kind:'missing'}|{kind:'invalid'}|{kind:'valid';yocto:bigint};
// Read the first whole numeric token before NEAR/N, including its sign. Detect
// malformed numbers before validating so they cannot fall back to the cap or
// be partially read as a smaller, positive amount.
export function amountIn(question:string):QuestionAmount{
 const m=/(?<![\w.,+\-−])((?:[+\-−]\s*)*[\d.]\S*?(?:[ \t]+[\d.]\S*?)*?)\s*(?:near|n)\b/i.exec(question);
 if(!m)return {kind:'missing'};
 const decimal=/^(?:\+\s*)?(\d{1,15}(?:\.\d{1,24})?|\.\d{1,24})$/.exec(m[1].trim());
 if(!decimal)return {kind:'invalid'};
 const [whole,fraction='']=decimal[1].split('.');
 const yocto=BigInt(whole||'0')*YOCTO+BigInt(fraction.padEnd(24,'0'));
 return yocto>0n?{kind:'valid',yocto}:{kind:'invalid'};
}
const near=(y:bigint)=>formatNear(y)+' NEAR';
const plural=(n:bigint,one:string,many:string)=>`${n} ${n===1n?one:many}`;

export function fitEvidence(pack:FactsPack,question:string){
 const snapshot:any=pack.vault.policy_snapshot,policy=snapshot?.policy,rules=pack.vault.rules;
 const patterns:string[]=[],examples:string[]=[];
 const add=(pattern:string,example:string)=>{patterns.push(pattern);examples.push(example);};
 // also: the how-to card rendered under this fact when it points the owner to one.
 const done=(text:string,also:string[]=[])=>{patterns.unshift(...text.split(/(?<=[.])\s+/).map(s=>escape(s.replace(/[.]$/,''))));return {key:'fit',text,ids:[] as string[],voice:{patterns,examples},also};};
 const none='(?:0|zero|no|none of (?:them|those)) payments? (?:can|could) go through(?: right now)?';
 // A bare yes/none is only offered when it agrees with the computed answer.
 const answer=(fits:boolean)=>fits?add('yes','Yes'):add('(?:none|no)','None');
 const asked=amountIn(question);
 if(asked.kind==='invalid'){
  const message='Please enter a positive NEAR amount, such as 0.1 NEAR, using at most 24 decimal places.';
  add(escape(message.slice(0,-1)),message.slice(0,-1));
  return done(message);
 }
 if(pack.vault.controls?.paused===true){
  answer(false);
  add(`${none},? (?:because |since )?(?:your |the )?(?:vault|payments) (?:is|are) paused`,'No payments can go through right now because payments are paused');
  return done('0 payments can go through right now: payments are paused. Unpause first.',['help:pause']);
 }
 if(snapshot&&policy===null){
  answer(false);
  add(`${none},? (?:because |since )?(?:your |the )?vault has no spending policy`,'No payments can go through right now because the vault has no spending policy');
  return done('0 payments can go through right now: the vault has no spending policy. Set one first.',['help:policy']);
 }
 if(rules?.expired===true){
  answer(false);
  add(`${none},? (?:because |since )?(?:your |the )?spending policy has expired`,'No payments can go through right now because your spending policy has expired');
  add('renew (?:it|the policy|your (?:spending )?policy) first','Renew your policy first');
  return done('0 payments can go through right now: the spending policy has expired. Renew it first.',['help:renew']);
 }
 const per=digits(policy?.per_payment)?BigInt(policy.per_payment):null,limit=digits(policy?.daily_limit)?BigInt(policy.daily_limit):null;
 const usage=digits(snapshot?.usage)?BigInt(snapshot.usage):null,min=digits(snapshot?.min_payment)?BigInt(snapshot.min_payment):null;
 const available=digits(pack.vault.available_yocto)?BigInt(pack.vault.available_yocto as string):null;
 if(rules?.expired!==false||per===null||per<=0n||limit===null||usage===null||available===null)
  return done('Dave cannot work out what fits: the vault did not return its policy, rolling budget and balance.');
 const size=asked.kind==='valid'?asked.yocto:per,X=escape(near(size));
 const lead=asked.kind==='missing'?`At your full per-payment limit of ${near(per)}: `:'';
 if(size>per){
  answer(false);
  add(`(?:(?:none|no|zero|0)(?: payments)?(?: can go through)?,? (?:because |since )?)?(?:a |an? )?${X} payment (?:is|would be) over (?:your|the) ${escape(near(per))} per-payment (?:limit|cap)`,`None: a ${near(size)} payment is over your ${near(per)} per-payment limit`);
  return done(`None: a ${near(size)} payment is over your ${near(per)} per-payment limit.`);
 }
 if(min!==null&&size<min){
  answer(false);
  add(`(?:(?:none|no|zero|0)(?: payments)?,? (?:because |since )?)?(?:a |an? )?${X} payment (?:is|would be) under (?:your|the) ${escape(near(min))} minimum`,`None: a ${near(size)} payment is under your ${near(min)} minimum`);
  return done(`None: a ${near(size)} payment is under your ${near(min)} minimum.`);
 }
 const remaining=limit>usage?limit-usage:0n,byBudget=remaining/size,byBalance=available/size;
 const n=byBudget<byBalance?byBudget:byBalance,count=`(?:${n})`;
 answer(n>0n);
 add(`(?:your |the )?vault holds ${byBudget<=byBalance?'':'only '}${escape(near(available))}`,`Your vault holds ${near(available)}`);
 if(byBudget<=byBalance){
  add(`${count} payments? of ${X} (?:can )?fit(?: in (?:the |your )?${escape(near(remaining))} left in your rolling (?:24-hour|daily) budget)?`,`${plural(n,'payment','payments')} of ${near(size)} fit in the ${near(remaining)} left in your rolling 24-hour budget`);
  add('(?:your |the )?(?:rolling )?budget is the limit','The budget is the limit');
  return done(`${lead}${plural(n,'payment','payments')} of ${near(size)} fit in the ${near(remaining)} left in your rolling 24-hour budget. The budget is the limit; the vault holds ${near(available)}.`);
 }
 add(`${count} payments? of ${X} (?:can )?fit(?:,? (?:because |since )?(?:your |the )?vault holds only ${escape(near(available))})?`,`${plural(n,'payment','payments')} of ${near(size)} fit because the vault holds only ${near(available)}`);
 add('(?:your |the )?(?:vault )?balance is the limit','The balance is the limit');
 return done(`${lead}${plural(n,'payment','payments')} of ${near(size)} fit: the vault holds only ${near(available)}, less than the ${near(remaining)} left in your rolling 24-hour budget. The balance is the limit.`);
}
