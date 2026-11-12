import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setupCafe,receiveCafe,payCafe,readCafe,topUpCafe,backupCafe} from '../agent/demo-cafe.ts';
import {parseNear} from '../app/sandbox.ts';

test('café pays each real bill once, rejects tampering, enforces budget/week, and backs up reset data',{timeout:240000},async()=>{
 const directory=join(mkdtempSync(join(tmpdir(),'countersign-cafe-')),'agent-vault');
 let backup:string|null=null;
 try{
  const opened:any=await setupCafe(directory);assert.equal(opened.suppliers.length,3);
  assert.ok(opened.suppliers.every((s:any)=>s.received==='0'));
  const received:any=await receiveCafe(directory);
  assert.equal(received.bills.length,6);assert.equal(received.rejected.length,1);
  assert.match(received.rejected[0].reason,/Invalid merchant signature/);
  const paid:any=await payCafe(directory,false,{running:false,completed:0,total:0,current:null});
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
