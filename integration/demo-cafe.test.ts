import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setupCafe,receiveCafe,payCafe,readCafe,topUpCafe,backupCafe,walletFaucetCafe,depositCafe,RESERVE_MESSAGE,setRulesCafe,renewRulesCafe,retryCafeBill} from '../agent/demo-cafe.ts';
import {parseNear} from '../app/sandbox.ts';
import {lookalike} from '../agent/ask/check.ts';
import {runAgentBill} from '../agent/desk-web.ts';
import {createDemoRoute} from '../app/demo-route.ts';

test('pay-one settles only its chosen café bill once on chain',{timeout:240000},async()=>{
 const directory=join(mkdtempSync(join(tmpdir(),'countersign-cafe-one-')),'agent-vault');
 try{
 await setupCafe(directory);
 const received:any=await receiveCafe(directory);
 const id=received.mail.invoices.find((invoice:any)=>invoice.id.startsWith('INV-BEANS-01-')).id;
 const state=()=>readCafe(directory),op=async()=>({});
 const route=createDemoRoute({network:()=>undefined,state,setup:op,receive:op,pay:op,
  payOne:async bill=>{const {record}=await runAgentBill(directory,bill,false);return {record,state:await state()};},
  faucet:op,walletFaucet:op,deposit:op,setRules:op,renewRules:op,retry:op,reset:op,modelReady:()=>false});
 assert.equal((await route('POST','/api/demo/pay-one',{id:'INV-UNKNOWN'})).status,400);
 const first=await route('POST','/api/demo/pay-one',{id});
 assert.equal(first.status,200);
 const after:any=await state();
 assert.equal(after.bills.find((bill:any)=>bill.id===id).outcome,'paid');
 assert.equal(after.suppliers.find((supplier:any)=>supplier.id==='Bean-Co').received,parseNear('0.4'));
 for(const supplier of after.suppliers.filter((supplier:any)=>supplier.id!=='Bean-Co'))assert.equal(supplier.received,'0');
 assert.equal((await route('POST','/api/demo/pay-one',{id})).status,400);
 const again:any=await state();
 assert.deepEqual(again.suppliers.map((supplier:any)=>supplier.received),after.suppliers.map((supplier:any)=>supplier.received));
 }finally{if(existsSync(directory))await backupCafe(directory);}
});

test('café pays each real bill once, rejects tampering, enforces budget/week, and backs up reset data',{timeout:240000},async()=>{
 const directory=join(mkdtempSync(join(tmpdir(),'countersign-cafe-')),'agent-vault');
 let backup:string|null=null;
 try{
  const opened:any=await setupCafe(directory);assert.equal(opened.suppliers.length,3);
  assert.ok(opened.suppliers.every((s:any)=>s.received==='0'));
  // The bank: wallet faucet adds exactly 5 NEAR to the owner; a deposit moves exactly its amount.
  const funded5:any=await walletFaucetCafe(directory);
  assert.equal(BigInt(funded5.wallet_yocto)-BigInt(opened.wallet_yocto),BigInt(parseNear('5')));
  assert.equal(funded5.available,opened.available);
  const deposited:any=await depositCafe(directory,'2');
  assert.equal(BigInt(deposited.available)-BigInt(funded5.available),BigInt(parseNear('2')));
  const fees=BigInt(funded5.wallet_yocto)-BigInt(deposited.wallet_yocto)-BigInt(parseNear('2'));
  assert.ok(fees>0n&&fees<BigInt(parseNear('0.01')),'wallet pays the amount plus small gas fees: '+fees);
  const limit=BigInt(deposited.wallet_yocto)-BigInt(parseNear('0.5'));
  const over=(limit+1n).toString(),whole=over.slice(0,-24)||'0',frac=over.slice(-24).padStart(24,'0');
  await assert.rejects(()=>depositCafe(directory,`${whole}.${frac}`),new RegExp(RESERVE_MESSAGE.replace(/\./g,'\\.')));
  await assert.rejects(()=>depositCafe(directory,'0'),/greater than 0/);
  const unchanged:any=await readCafe(directory);
  assert.equal(unchanged.available,deposited.available);
  assert.deepEqual(unchanged.bank.map((e:any)=>[e.kind,e.amount]),[['faucet',parseNear('5')],['deposit',parseNear('2')]]);
  // Your rules: the CLI's set_policy path, read back from the vault; renew keeps the limits.
  const before:any=unchanged.policy;
  const saved:any=await setRulesCafe(directory,{per_bill:'0.45',daily_budget:'1.7',hours:'3'});
  assert.equal(saved.policy.per_payment_near,'0.45');assert.equal(saved.policy.rolling_24h_limit_near,'1.7');
  assert.equal(saved.policy.min_payment_near,before.min_payment_near);
  assert.deepEqual(saved.policy.merchants,before.merchants);
  const hours=(Number(saved.policy.expires_at_ms)-Date.now())/3600000;assert.ok(hours>2.9&&hours<=3,'expiry about 3 hours out: '+hours);
  await assert.rejects(()=>setRulesCafe(directory,{per_bill:'3',daily_budget:'2',hours:'3'}),/can't be more than the daily budget/);
  await assert.rejects(()=>setRulesCafe(directory,{per_bill:'0.5',daily_budget:'2',hours:'25'}),/from 1 to 24 hours/);
  await assert.rejects(()=>setRulesCafe(directory,{per_bill:'0.001',daily_budget:'2',hours:'1'}),/at least the minimum payment \(0\.005 NEAR\)/);
  await assert.rejects(()=>renewRulesCafe(directory),/already last longer than 2 more hours/);
  // Back to the café's usual limits for 1 hour, then renew for 2: later expiry, same limits.
  const short:any=await setRulesCafe(directory,{per_bill:'0.5',daily_budget:'1.2',hours:'1'});
  const renewed:any=await renewRulesCafe(directory);
  assert.ok(Number(renewed.policy.expires_at_ms)>Number(short.policy.expires_at_ms));
  assert.deepEqual([renewed.policy.per_payment_near,renewed.policy.rolling_24h_limit_near,renewed.policy.min_payment_near,renewed.policy.merchants],
   [short.policy.per_payment_near,short.policy.rolling_24h_limit_near,short.policy.min_payment_near,short.policy.merchants]);
  assert.ok(Number(renewed.policy.version)>Number(short.policy.version));
  const previous=process.env.COUNTERSIGN_NETWORK;process.env.COUNTERSIGN_NETWORK='testnet';
  try{
   await assert.rejects(()=>setRulesCafe(directory,{per_bill:'0.5',daily_budget:'2',hours:'3'}),/only on the local sandbox/);
   await assert.rejects(()=>renewRulesCafe(directory),/only on the local sandbox/);
   await assert.rejects(()=>walletFaucetCafe(directory),/only on the local sandbox/);
   await assert.rejects(()=>depositCafe(directory,'1'),/only on the local sandbox/);
  }finally{if(previous===undefined)delete process.env.COUNTERSIGN_NETWORK;else process.env.COUNTERSIGN_NETWORK=previous;}
  const received:any=await receiveCafe(directory);
  assert.equal(received.bills.length,6);assert.equal(received.rejected.length,1);
  assert.match(received.rejected[0].reason,/Invalid merchant signature/);
  // Demo mailbox copy: every delivered invoice, the tampered one as written.
  assert.equal(received.mail.invoices.length,7);
  assert.equal(received.rejected[0].payee,received.scam.payee);
  // The tampered invoice pays a lookalike of Bean Co's payout, which Ask Dave's check catches.
  assert.match(received.scam.payee,/^bean5\./);
  assert.ok(lookalike(received.scam.payee,received.suppliers.find((s:any)=>s.id==='Bean-Co').payee));
  assert.equal(received.mail.invoices.find((i:any)=>i.id===received.rejected[0].id).payee,received.scam.payee);
  assert.deepEqual(received.mail.invoices.filter((i:any)=>i.merchant==='Milk-Co').map((i:any)=>i.week),[1,1]);
  assert.ok(received.mail.invoices.filter((i:any)=>i.merchant!=='Milk-Co').every((i:any)=>i.week===null));
  const progress:any={running:false,completed:0,total:0,current:null};
  const vaultBeforeRun=received.available;
  const paid:any=await payCafe(directory,false,progress);
  assert.equal(paid.scam.received,'0');
  for(const supplier of paid.suppliers){
   assert.equal(supplier.received,parseNear('0.4'));assert.equal(supplier.paid_count,1);
   assert.equal(supplier.receipts[0].state,'Settled');assert.ok(supplier.receipts[0].attempt_id);
   assert.match(supplier.receipts[0].payload_hash,/^[0-9a-f]{64}$/);
  }
  assert.match(paid.bills.find((b:any)=>b.id.startsWith('INV-BEANS-02')).error,/Merchant bill already used/i);
  assert.match(paid.bills.find((b:any)=>b.id.startsWith('INV-MILK-02')).error,/Service period already claimed/i);
  assert.match(paid.bills.find((b:any)=>b.id.startsWith('INV-PASTRY-02')).error,/rolling daily budget exceeded/i);
  const again:any=await payCafe(directory,false,{running:false,completed:0,total:0,current:null});
  assert.deepEqual(again.suppliers,paid.suppliers);
  const funded:any=await topUpCafe(directory);assert.equal(BigInt(funded.available)-BigInt(paid.available),BigInt(parseNear('5')));
  // Progress reports each bill's real outcome as it finishes, in processing order.
  assert.equal(progress.results.length,6);
  assert.deepEqual(progress.results.map((r:any)=>r.id),progress.order);
  assert.deepEqual(paid.run.order,progress.order);
  for(const result of progress.results)assert.equal(result.outcome,paid.bills.find((b:any)=>b.id===result.id).outcome,result.id);
  assert.equal(progress.vault_before,vaultBeforeRun);assert.equal(paid.day_vault_start,vaultBeforeRun);
  // Try again: only budget stops; still stopped under the old budget; paid once after raising it, never twice.
  const pastry2=funded.bills.find((b:any)=>b.id.startsWith('INV-PASTRY-02')),beans2=funded.bills.find((b:any)=>b.id.startsWith('INV-BEANS-02'));
  const pastryReceived=(state:any)=>state.suppliers.find((s:any)=>s.id==='Pastry-Co');
  assert.equal(pastry2.has_proposal,true);
  await assert.rejects(()=>retryCafeBill(directory,beans2.id),/Only bills stopped by the daily budget/);
  await assert.rejects(()=>retryCafeBill(directory,funded.rejected[0].id),/Unknown invoice/);
  const still:any=await retryCafeBill(directory,pastry2.id);
  assert.equal(still.bills.find((b:any)=>b.id===pastry2.id).outcome,'blocked');
  assert.equal(pastryReceived(still).received,parseNear('0.4'));
  await setRulesCafe(directory,{per_bill:'0.5',daily_budget:'2',hours:'1'});
  const retried:any=await retryCafeBill(directory,pastry2.id);
  assert.equal(retried.bills.find((b:any)=>b.id===pastry2.id).outcome,'paid');
  assert.equal(pastryReceived(retried).received,parseNear('0.9'));assert.equal(pastryReceived(retried).paid_count,2);
  assert.equal(BigInt(funded.available)-BigInt(retried.available),BigInt(parseNear('0.5')));
  await assert.rejects(()=>retryCafeBill(directory,pastry2.id),/Only bills stopped by the daily budget/);
  const settled:any=await readCafe(directory);
  assert.equal(pastryReceived(settled).received,parseNear('0.9'));assert.equal(settled.available,retried.available);
  const next:any=await receiveCafe(directory);assert.equal(next.bills.length,12);assert.equal(next.rejected.length,2);
  const original=readFileSync(join(directory,'cafe.json'),'utf8');
  writeFileSync(join(directory,'keep-me.txt'),'preserve this');
  backup=await backupCafe(directory);assert.ok(backup);assert.equal(existsSync(directory),false);
  assert.equal(readFileSync(join(backup,'cafe.json'),'utf8'),original);
  assert.equal(readFileSync(join(backup,'keep-me.txt'),'utf8'),'preserve this');
  const fresh:any=await setupCafe(directory);assert.equal(fresh.suppliers[0].received,'0');
  assert.equal((await readCafe(directory) as any).bills.length,0);
 }finally{
  if(existsSync(directory))await backupCafe(directory);
 }
});
