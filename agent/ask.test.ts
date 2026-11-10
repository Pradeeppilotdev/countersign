import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {buildFacts,formatNear,reasonCode} from './ask/facts.ts';
import {readInbox} from './ask/inbox-reader.ts';
import {VIEW_METHODS,openVaultReader} from './ask/views.ts';

const askDir=fileURLToPath(new URL('./ask/',import.meta.url));
const near=(n:string)=>{const [w,f='']=n.split('.');return (BigInt(w)*10n**24n+BigInt(f.padEnd(24,'0'))).toString();};

test('Ask Dave module imports no signing or transaction code',()=>{
 // Only these may be loaded by anything under agent/ask: file reads, SQLite and its own files.
 const allowed=new Set(['node:fs','node:path','node:sqlite']);
 const files=readdirSync(askDir,{recursive:true}).map(String).filter(f=>f.endsWith('.ts'));
 assert.deepEqual(files.sort(),['cli.ts','facts.ts','inbox-reader.ts','views.ts']);
 for(const file of files){
  const text=readFileSync(join(askDir,file),'utf8');
  const code=text.replace(/\/\/.*$/gm,'');
  const specifiers=[...code.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g),...code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)].map(m=>m[1]);
  for(const specifier of specifiers){
   if(specifier.startsWith('.')){
    const target=resolve(dirname(join(askDir,file)),specifier);
    assert.ok(target.startsWith(askDir)&&files.includes(target.slice(askDir.length)),`${file} imports ${specifier} from outside agent/ask`);
   }else assert.ok(allowed.has(specifier),`${file} imports ${specifier}`);
  }
  // No dynamic loading, child processes or any way to reach a signer or submit a transaction.
  for(const banned of [/\bimport\s*\(/,/\brequire\s*\(/,/createRequire/,/child_process/,/node:crypto/,/near-workspaces/,/near-api-js/,/KeyPair|keyStore|secretKey|privateKey/i,/broadcast_tx|send_tx|signTransaction|functionCall/,/\.call\s*\(/,/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/])
   assert.equal(banned.test(code),false,`${file} contains ${banned}`);
 }
 const views=readFileSync(join(askDir,'views.ts'),'utf8');
 assert.deepEqual([...views.matchAll(/rpc\('([a-z_]+)'/g)].map(m=>m[1]).sort(),['block','query']);
 assert.ok(views.includes("request_type:'call_function'"));
 assert.ok(readFileSync(join(askDir,'inbox-reader.ts'),'utf8').includes('readOnly:true'));
 // Every permitted contract method is a view: none of the contract's state-changing methods is listed.
 const changing=['fund','authorize','authorize_route','authorize_by_policy','authorize_signed_invoice','reserve','execute','cancel','release_failed','set_policy','renew_policy','revoke_policy','clear_policy_approvals','set_paused','set_executor','configure_invoice_auth','set_merchant_key','add_weekly_service','revoke_weekly_service','on_transfer'];
 for(const method of VIEW_METHODS)assert.equal(changing.includes(method),false,method);
});

test('the vault reader refuses a missing vault and a view that is not on the allowlist',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ask-reader-'));
 try{await assert.rejects(()=>openVaultReader(dir),/Initialize the agent vault/);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('NEAR formatting and reason categories',()=>{
 assert.equal(formatNear(near('0.4')),'0.4');assert.equal(formatNear('1'),'0.000000000000000000000001');
 assert.equal(formatNear(near('5')),'5');assert.equal(formatNear('0'),'0');assert.equal(formatNear('abc'),null);
 assert.equal(reasonCode('Invalid merchant signature.'),'rejected_signature');
 assert.equal(reasonCode('Merchant bill already used.'),'duplicate_bill');
 assert.equal(reasonCode('Rolling daily budget exceeded.'),'over_limit');
 assert.equal(reasonCode('Service period already claimed by [INV-A].'),'period_claimed');
 assert.equal(reasonCode('Payment outcome pending; resume the same invoice'),'unconfirmed');
 assert.equal(reasonCode('something new'),'other');assert.equal(reasonCode(null),null);
});

test('facts pack: totals, weekly services, stuck items and 3x-median flag from a read-only inbox copy',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ask-facts-')),path=join(dir,'inbox.db');
 const payee='merchant.test.near',week='604800000',service={agreement_id:'weekly-milk',period_start_ms:week};
 const rows:[string,string,string,string,string|null,any][]=[
  ['A','beans',near('0.1'),'settled',null,null],
  ['B','beans',near('0.1'),'settled',null,null],
  ['C','beans',near('0.2'),'settled',null,null],
  ['BIG','beans',near('0.45'),'proposal_ready','Per-payment cap exceeded.',null],
  ['FLIGHT','beans',near('0.1'),'proposal_ready','Payment outcome pending; resume the same invoice',null],
  ['MODEL','beans',near('0.1'),'proposal_failed','Model proposal unavailable or rejected',null],
  ['HUNG','beans',near('0.1'),'inference_pending',null,null],
  ['GHOST','beans',near('0.1'),'settled',null,null],
  ['GONE','beans',near('0.1'),'cancelled',null,null],
  ['W1','milk',near('0.04'),'settled',null,{bill_id:'m-1',key_version:'1',expires_at:'700000000',service,signature:'never-copied',domain:'never-copied'}],
  ['W2','milk',near('0.04'),'period_claimed','Service period already claimed by [W1].',{bill_id:'m-2',key_version:'1',expires_at:'700000000',service,signature:'never-copied',domain:'never-copied'}],
 ];
 const writer=new DatabaseSync(path);
 writer.exec('CREATE TABLE inbox_scope (id INTEGER PRIMARY KEY,vault TEXT NOT NULL);CREATE TABLE inbox (id TEXT PRIMARY KEY,invoice TEXT NOT NULL,merchant TEXT NOT NULL,commitment TEXT NOT NULL,state TEXT NOT NULL,generation INTEGER NOT NULL DEFAULT 0,proposal TEXT,error TEXT,signed_invoice TEXT);CREATE TABLE attempts (invoice_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE, commitment TEXT NOT NULL, state TEXT NOT NULL)');
 writer.prepare('INSERT INTO inbox_scope VALUES(1,?)').run('session:vault.test.near');
 for(const [id,merchant,amount,state,error,signed] of rows)writer.prepare('INSERT INTO inbox(id,invoice,merchant,commitment,state,error,signed_invoice) VALUES(?,?,?,?,?,?,?)').run(id,JSON.stringify({id,payee,asset:'near',amount}),merchant,'c',state,error,signed?JSON.stringify({...signed,invoice:{id,payee,asset:'near',amount}}):null);
 writer.prepare('INSERT INTO attempts VALUES(?,?,?,?)').run('FLIGHT','attempt-flight','c','unknown');
 writer.close();
 const before=readFileSync(path);
 try{
  const inbox=readInbox(path);
  assert.equal(inbox.scope,'session:vault.test.near');
  assert.equal(JSON.stringify(inbox).includes('never-copied'),false);
  const chainState:Record<string,string>={A:'Settled',B:'Settled',C:'Settled',FLIGHT:'Executing',GONE:'Cancelled',W1:'Settled'};
  const calls:string[]=[];
  const pack=await buildFacts({vault:'vault.test.near',block_height:7,inbox,async view(method,args:any){
   calls.push(method);
   if(method==='policy_snapshot')return {policy:{version:'2',merchants:[{id:'beans',payee},{id:'milk',payee}],per_payment:near('0.4'),daily_limit:near('1'),expires_at:'650000000'},min_payment:near('0.01'),usage:near('0.44'),now:'650000001'};
   if(method==='policy_capacity')return undefined; // an older vault without this view
   if(method==='available_balance')return near('4.56');
   if(method==='get_vault_controls')return {owner:'owner.test.near',executor:'executor.test.near',paused:true};
   if(method==='get_payment'){const state=chainState[args.invoice_id],row=rows.find(r=>r[0]===args.invoice_id)!;return state?{invoice:{id:row[0],payee,asset:'near',amount:row[2]},commitment:'c',state,attempt_id:state==='Authorized'?null:'attempt'}:null;}
   if(method==='get_invoice_auth')return args.invoice_id==='W1'?{merchant_id:'milk',key_version:'1',payload_hash:'h'}:null;
   if(method==='invoice_expiry')return args.invoice_id==='HUNG'?'600000000':null;
   if(method==='get_weekly_service')return {merchant_id:'milk',payee,anchor_ms:'0',cap:near('0.05'),revoked:false};
   if(method==='current_service_period')return service;
   if(method==='get_service_claim')return 'W1';
   if(method==='get_merchant_key')return args.merchant_id==='milk'?{version:'1',public_key:'key'}:null;
   throw Error('unexpected view '+method);
  }});
  assert.ok(calls.every(method=>(VIEW_METHODS as readonly string[]).includes(method)));
  assert.deepEqual(readFileSync(path),before); // the inbox file is byte-for-byte untouched
  const by=Object.fromEntries(pack.invoices.map(i=>[i.id,i]));
  assert.deepEqual(pack.totals.counts,{queued:0,proposed:0,pending:3,paid:4,blocked:2,failed:1,cancelled:1});
  assert.deepEqual(pack.totals.inbox_states,{cancelled:1,inference_pending:1,period_claimed:1,proposal_failed:1,proposal_ready:2,settled:5});
  assert.equal(pack.totals.paid_near,'0.44');
  const beans=pack.totals.per_merchant.find(m=>m.merchant==='beans')!;
  assert.equal(beans.paid_near,'0.4');assert.equal(beans.median_paid_near,'0.1');assert.equal(beans.largest_paid_near,'0.2');assert.equal(beans.not_paid_near,'0.55');
  assert.deepEqual(pack.totals.per_day,{basis:'rolling_24h_policy_usage',used_near:'0.44',limit_near:'1',remaining_near:'0.56'});
  assert.deepEqual(pack.totals.per_week.weeks,[{agreement_id:'weekly-milk',period_start_ms:week,period_start:'1970-01-08T00:00:00.000Z',claimed_by:'W1',invoices:['W1','W2'],paid_near:'0.04'}]);
  assert.deepEqual([by.BIG.outcome,by.BIG.reason,by.BIG.flags],['blocked','over_limit',['blocked_attempt','over_3x_median']]);
  assert.deepEqual([by.FLIGHT.outcome,by.FLIGHT.reason,by.FLIGHT.agent.attempt_state],['pending','payment_in_flight','unknown']);
  assert.deepEqual([by.MODEL.outcome,by.MODEL.flags],['failed',['failed_attempt']]);
  assert.deepEqual([by.HUNG.outcome,by.HUNG.reason,by.HUNG.flags],['pending','awaiting_model',['stuck_pending','expired_unpaid']]);
  assert.deepEqual([by.GHOST.outcome,by.GHOST.flags],['pending',['stuck_pending','state_mismatch']]);
  assert.deepEqual([by.GONE.outcome,by.GONE.flags],['cancelled',[]]);
  assert.deepEqual([by.W2.outcome,by.W2.reason,by.W2.chain.service_claim,by.W2.flags],['blocked','period_claimed','W1',['blocked_attempt','period_claimed']]);
  assert.deepEqual(by.W1.signed,{bill_id:'m-1',key_version:'1',expires_at_ms:'700000000',expires_at:'1970-01-09T02:26:40.000Z',service});
  assert.deepEqual(pack.flags.map(f=>`${f.type}:${f.invoice_id}`).sort(),['blocked_attempt:BIG','blocked_attempt:W2','expired_unpaid:HUNG','failed_attempt:MODEL','over_3x_median:BIG','period_claimed:W2','state_mismatch:GHOST','stuck_pending:FLIGHT','stuck_pending:GHOST','stuck_pending:HUNG']);
  assert.deepEqual(pack.vault.alerts,['vault_paused','policy_expired']);
  assert.deepEqual(pack.source.views_unavailable,['policy_capacity']);
  assert.equal(pack.vault.rules!.per_payment_near,'0.4');assert.equal(pack.vault.rules!.expired,true);
  assert.deepEqual(pack.vault.merchant_keys,[{merchant_id:'beans',key_version:null,active:false},{merchant_id:'milk',key_version:'1',active:true}]);
  assert.deepEqual(pack.vault.weekly_services,[{agreement_id:'weekly-milk',service:{merchant_id:'milk',payee,cap_near:'0.05',anchor_ms:'0',anchor:'1970-01-01T00:00:00.000Z',revoked:false},
   current_period:{period_start_ms:week,period_start:'1970-01-08T00:00:00.000Z',claimed_by:'W1'},periods:[{period_start_ms:week,period_start:'1970-01-08T00:00:00.000Z',claimed_by:'W1',invoices:['W1','W2'],paid_near:'0.04'}]}]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
