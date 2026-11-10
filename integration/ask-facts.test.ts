// Ask Dave, step 1: run a fresh local café story through the real agent:desk
// CLI, then check that `ask --facts` reports exactly what happened and changes nothing.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFile} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {parseNear} from '../app/sandbox.ts';
import {commitment} from '../executor/core.ts';
import {publicKeyBase64,signInvoice,type ServicePeriod,type SignedInvoice} from '../merchant/invoice.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const exec=promisify(execFile);

test('facts pack matches a fresh café run: paid, tampered, duplicate, over-budget, queued and weekly bills',{timeout:420000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'countersign-ask-'));
 const run=(...args:string[])=>exec(process.execPath,['--disable-warning=ExperimentalWarning','agent/desk.ts',...args],{
  cwd:root,env:{...process.env,COUNTERSIGN_AGENT_DIR:directory,NEAR_AI_API_KEY:'',NEAR_AI_MODEL:''},timeout:90000,maxBuffer:8<<20,
 });
 const cli=async(...args:string[])=>{const {stdout}=await run(...args);return JSON.parse(stdout.slice(stdout.search(/^[\[{]/m)));};
 const refused=async(reason:RegExp,...args:string[])=>assert.rejects(()=>run(...args),(error:any)=>{assert.equal(error.code,1);assert.match(error.stderr,reason);return true;});
 const rows=()=>{const db=new DatabaseSync(join(directory,'inbox.db'),{readOnly:true});try{return JSON.stringify([db.prepare('SELECT * FROM inbox ORDER BY rowid').all(),db.prepare('SELECT * FROM attempts ORDER BY invoice_id').all()]);}finally{db.close();}};
 try{
  // Dave opens a vault, pins his supplier's key and sets his rules once.
  const state=await cli('init');
  await cli('policy','0.5','0.8','120','0.01');
  const pair=generateKeyPairSync('ed25519');
  const key=await cli('merchant-key','local-merchant',publicKeyBase64(pair.publicKey));
  const sign=(id:string,amount:string,bill_id:string,service?:ServicePeriod)=>signInvoice({
   invoice:{id,payee:state.merchant,asset:'near',amount:parseNear(amount)},merchant_id:'local-merchant',bill_id,
   vault:state.vault,domain:key.domain,key_version:key.version,expires_at:String(Date.now()+600000),...(service?{service}:{}),
  },pair.privateKey);
  const bring=async(signed:SignedInvoice)=>{
   const file=join(directory,signed.invoice.id+'.json');writeFileSync(file,JSON.stringify(signed),{mode:0o600});
   assert.equal((await cli('import',file)).state,'queued');
  };

  // 1. A genuine signed bean invoice is paid.
  const beans=sign('INV-BEANS-001','0.4','BEANS-NOV-A');
  await bring(beans);
  assert.equal((await cli('run','INV-BEANS-001')).state,'settled');

  // 2a. A scammer edits the signed file before it arrives: refused at the door, nothing stored.
  const edited=join(directory,'edited.json');
  writeFileSync(edited,JSON.stringify({...beans,invoice:{...beans.invoice,id:'INV-BEANS-FAKE',amount:parseNear('0.5')}}),{mode:0o600});
  await refused(/Invalid merchant signature/,'import',edited);
  // 2b. A genuine milk invoice is accepted, then its saved copy is edited from 0.05 to 0.5 NEAR.
  const milk=sign('INV-MILK-002','0.05','MILK-NOV-A');
  await bring(milk);
  const forged={...milk,invoice:{...milk.invoice,amount:parseNear('0.5')}};
  const scammer=new DatabaseSync(join(directory,'inbox.db'));
  try{scammer.prepare('UPDATE inbox SET invoice=?,commitment=?,signed_invoice=? WHERE id=?').run(JSON.stringify(forged.invoice),commitment(forged.invoice),JSON.stringify(forged),'INV-MILK-002');}finally{scammer.close();}
  await refused(/Invalid merchant signature/,'run','INV-MILK-002');

  // 3. The paid bean bill comes back under a new invoice number.
  await bring(sign('INV-BEANS-001-AGAIN','0.4','BEANS-NOV-A'));
  await refused(/Merchant bill already used/,'run','INV-BEANS-001-AGAIN');

  // 4. A real 0.5 NEAR invoice would take the day past the 0.8 NEAR budget.
  await bring(sign('INV-BEANS-003','0.5','BEANS-NOV-C'));
  await refused(/Rolling daily budget exceeded/,'run','INV-BEANS-003');

  // 5. A small invoice still fits and is paid; another waits in the queue.
  await bring(sign('INV-CUPS-004','0.1','CUPS-NOV-A'));
  assert.equal((await cli('run','INV-CUPS-004')).state,'settled');
  await bring(sign('INV-NAPKINS-005','0.02','NAPKINS-NOV-A'));

  const statusBefore=await cli('status'),rowsBefore=rows();
  const pack=await cli('ask','--facts');
  assert.deepEqual(await cli('status'),statusBefore); // balance, usage, policy, merchant receipts and inbox unchanged
  assert.equal(rows(),rowsBefore);
  if(process.env.COUNTERSIGN_ASK_FACTS_OUT){mkdirSync(dirname(process.env.COUNTERSIGN_ASK_FACTS_OUT),{recursive:true});writeFileSync(process.env.COUNTERSIGN_ASK_FACTS_OUT,JSON.stringify(pack,null,2));}

  assert.equal(pack.kind,'countersign.ask-dave.facts');assert.equal(pack.read_only,true);
  assert.equal(pack.source.vault,state.vault);assert.deepEqual(pack.source.views_unavailable,[]);
  const text=JSON.stringify(pack);
  for(const secret of [beans.signature,milk.signature,key.domain])assert.equal(text.includes(secret),false);

  // Dave's rules and balances, straight from the vault.
  assert.deepEqual(pack.vault.controls,statusBefore.controls);assert.deepEqual(pack.vault.alerts,[]);
  assert.equal(pack.vault.available_near,'4.5');assert.equal(pack.vault.available_yocto,statusBefore.available);
  assert.deepEqual({...pack.vault.rules,expires_at:0},{version:'1',merchants:[{id:'local-merchant',payee:state.merchant}],per_payment_near:'0.5',rolling_24h_limit_near:'0.8',min_payment_near:'0.01',expires_at_ms:statusBefore.policy.expires_at,expires_at:0,expired:false});
  assert.deepEqual(pack.vault.policy_snapshot.policy,statusBefore.policy);
  assert.deepEqual(pack.vault.policy_capacity,{min_payment:parseNear('0.01'),max_pending:16,max_charges:128,pending:0,charges:2,usage:parseNear('0.5')});
  assert.deepEqual(pack.vault.merchant_keys,[{merchant_id:'local-merchant',key_version:'1',active:true}]);
  assert.deepEqual(pack.vault.weekly_services,[]);

  // Every invoice: what the inbox says, what the vault says, and the plain outcome.
  const brief=(i:any)=>[i.id,i.merchant,i.amount_near,i.state,i.error,i.outcome,i.reason,i.chain.payment?.state??null,i.flags];
  assert.deepEqual(pack.invoices.map(brief),[
   ['INV-BEANS-001','local-merchant','0.4','settled',null,'paid',null,'Settled',[]],
   ['INV-MILK-002','local-merchant','0.5','proposal_ready','Invalid merchant signature.','blocked','rejected_signature',null,['blocked_attempt','rejected_signature']],
   ['INV-BEANS-001-AGAIN','local-merchant','0.4','proposal_ready','Merchant bill already used.','blocked','duplicate_bill',null,['blocked_attempt','duplicate_bill']],
   ['INV-BEANS-003','local-merchant','0.5','proposal_ready','Rolling daily budget exceeded.','blocked','over_limit',null,['blocked_attempt']],
   ['INV-CUPS-004','local-merchant','0.1','settled',null,'paid',null,'Settled',[]],
   ['INV-NAPKINS-005','local-merchant','0.02','queued',null,'queued',null,null,[]],
  ]);
  const [paid,tampered]=pack.invoices;
  assert.equal(paid.amount_yocto,parseNear('0.4'));assert.equal(paid.payee,state.merchant);
  assert.deepEqual(paid.signed,{bill_id:'BEANS-NOV-A',key_version:'1',expires_at_ms:beans.expires_at,expires_at:new Date(Number(beans.expires_at)).toISOString(),service:null});
  assert.equal(paid.chain.payment.amount_near,'0.4');assert.equal(paid.chain.payment.commitment,commitment(beans.invoice));
  assert.equal(paid.chain.invoice_auth.merchant_id,'local-merchant');assert.equal(paid.chain.invoice_expiry_ms,beans.expires_at);
  assert.equal(paid.agent.attempt_state,'settled');
  assert.deepEqual(tampered.chain,{payment:null,invoice_auth:null,invoice_expiry_ms:null,invoice_expiry:null,expired:null,service_claim:null});
  assert.equal(text.includes('INV-BEANS-FAKE'),false); // refused at import: never stored, so not in the facts

  // Totals worked out by code.
  assert.equal(pack.totals.invoices,6);
  assert.deepEqual(pack.totals.counts,{queued:1,proposed:0,pending:0,paid:2,blocked:3,failed:0,cancelled:0});
  assert.deepEqual(pack.totals.inbox_states,{proposal_ready:3,queued:1,settled:2});
  assert.equal(pack.totals.paid_near,'0.5');assert.equal(pack.totals.paid_yocto,statusBefore.merchantReceived);
  assert.deepEqual(pack.totals.per_merchant,[{merchant:'local-merchant',invoices:6,counts:pack.totals.counts,paid_near:'0.5',paid_yocto:parseNear('0.5'),median_paid_near:'0.25',largest_paid_near:'0.4',not_paid_near:'1.4'}]);
  assert.deepEqual(pack.totals.per_day,{basis:'rolling_24h_policy_usage',used_near:'0.5',limit_near:'0.8',remaining_near:'0.3'});
  assert.deepEqual(pack.totals.per_week,{basis:'signed_service_weeks',weeks:[]});
  assert.deepEqual(pack.flags.map((f:any)=>[f.type,f.invoice_id,f.amount_near,f.detail]),[
   ['blocked_attempt','INV-MILK-002','0.5','Invalid merchant signature.'],
   ['rejected_signature','INV-MILK-002','0.5','Invalid merchant signature.'],
   ['blocked_attempt','INV-BEANS-001-AGAIN','0.4','Merchant bill already used.'],
   ['duplicate_bill','INV-BEANS-001-AGAIN','0.4','Merchant bill already used.'],
   ['blocked_attempt','INV-BEANS-003','0.5','Rolling daily budget exceeded.'],
  ]);

  // Unknown flags are refused, and a question without a model key stops before any model request.
  await refused(/Usage: agent:desk ask --facts/,'ask','--pay');
  await refused(/Usage: agent:desk/,'ask');
  await refused(/Set NEAR_AI_API_KEY and NEAR_AI_MODEL/,'ask','What did I pay this week?');

  // "Is this invoice OK?" on real files, through the CLI. Still nothing changes.
  const check=async(file:string)=>{const result=await cli('ask','--check',file);return [result.verdict,Object.fromEntries(result.checks.map((c:any)=>[c.check,c.result]))];};
  const allGood={pinned_payee:'good',signature:'good',already_paid:'good',fits_policy:'good',lookalike:'good',amount_vs_median:'good'};
  assert.deepEqual(await check(join(directory,'INV-NAPKINS-005.json')),['good',allGood]);
  assert.deepEqual(await check(edited),['bad',{...allGood,signature:'bad',already_paid:'bad',fits_policy:'caution'}]); // edited copy of the paid bean bill: forged, a repeat, and over what is left today
  assert.deepEqual(await check(join(directory,'INV-BEANS-001.json')),['caution',{...allGood,already_paid:'caution',fits_policy:'caution'}]);
  assert.deepEqual(await check(join(directory,'INV-BEANS-001-AGAIN.json')),['bad',{...allGood,already_paid:'bad',fits_policy:'caution'}]);
  const copycat=join(directory,'copycat.json');
  writeFileSync(copycat,JSON.stringify(signInvoice({invoice:{id:'INV-BEANS-900',payee:state.merchant,asset:'near',amount:parseNear('0.1')},merchant_id:'local-merchent',bill_id:'BEANS-NOV-Z',vault:state.vault,domain:key.domain,key_version:'1',expires_at:String(Date.now()+600000)},generateKeyPairSync('ed25519').privateKey)));
  assert.deepEqual(await check(copycat),['caution',{...allGood,pinned_payee:'caution',signature:'caution',fits_policy:'caution',lookalike:'caution'}]);
  assert.deepEqual(await cli('status'),statusBefore);assert.equal(rows(),rowsBefore);

  // A weekly service: the first bill for the week is paid, the second is turned away.
  const anchor=String(Date.now()-3600000),service={agreement_id:'weekly-beans',period_start_ms:anchor};
  await cli('weekly-service','weekly-beans','local-merchant','0.1',anchor);
  await bring(sign('INV-WEEK-A','0.05','WEEKLY-801',service));
  assert.equal((await cli('run','INV-WEEK-A')).state,'settled');
  await bring(sign('INV-WEEK-B','0.05','WEEKLY-947',service));
  assert.equal((await cli('run','INV-WEEK-B')).state,'period_claimed');
  const weekly=await cli('ask','--facts');
  const period={period_start_ms:anchor,period_start:new Date(Number(anchor)).toISOString(),claimed_by:'INV-WEEK-A'};
  assert.deepEqual(weekly.vault.weekly_services,[{agreement_id:'weekly-beans',
   service:{merchant_id:'local-merchant',payee:state.merchant,cap_near:'0.1',anchor_ms:anchor,anchor:period.period_start,revoked:false},
   current_period:period,periods:[{...period,invoices:['INV-WEEK-A','INV-WEEK-B'],paid_near:'0.05'}]}]);
  assert.deepEqual(weekly.totals.per_week.weeks,[{agreement_id:'weekly-beans',...period,invoices:['INV-WEEK-A','INV-WEEK-B'],paid_near:'0.05'}]);
  assert.deepEqual(weekly.invoices.slice(6).map(brief),[
   ['INV-WEEK-A','local-merchant','0.05','settled',null,'paid',null,'Settled',[]],
   ['INV-WEEK-B','local-merchant','0.05','period_claimed','Service period already claimed by [INV-WEEK-A].','blocked','period_claimed',null,['blocked_attempt','period_claimed']],
  ]);
  assert.equal(weekly.invoices[7].chain.service_claim,'INV-WEEK-A');
  assert.deepEqual(weekly.totals.counts,{queued:1,proposed:0,pending:0,paid:3,blocked:4,failed:0,cancelled:0});
  assert.equal(weekly.totals.per_day.used_near,'0.55');assert.equal(weekly.vault.available_near,'4.45');
  if(process.env.COUNTERSIGN_ASK_FACTS_OUT)writeFileSync(process.env.COUNTERSIGN_ASK_FACTS_OUT.replace(/\.json$/,'')+'-weekly.json',JSON.stringify(weekly,null,2));
 }finally{
  try{process.kill(JSON.parse(readFileSync(join(directory,'chain.json'),'utf8')).pid,'SIGTERM');}catch{}
 }
});
