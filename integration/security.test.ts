import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SandboxDesk,parseNear} from '../app/sandbox.ts';
import {Executor,type Payment} from '../executor/core.ts';
import {vaultAdapters} from '../executor/vault.ts';

test('atomic initialization, browser RPC denial, and native recovery across interrupted submissions',{timeout:240_000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'countersign-security-')),d=new SandboxDesk(directory);
 try{
  await d.start();
  const attacker=await d.worker.rootAccount.createSubAccount('attacker');
  const uninitialized=await d.worker.rootAccount.devDeploy('contract/target/wasm32-unknown-unknown/release/countersign.wasm');
  const takeover=await attacker.callRaw(uninitialized,'new',{owner:attacker.accountId,executor:attacker.accountId});
  assert.equal(takeover.failed,true);assert.ok(takeover.receiptFailureMessagesContain('private'));
  const again=await attacker.callRaw(d.vault,'new',{owner:attacker.accountId,executor:attacker.accountId});assert.equal(again.failed,true);
  const rpc=d.worker.provider.connection.url;
  const query={jsonrpc:'2.0',id:'security',method:'query',params:{request_type:'view_account',account_id:d.merchant.accountId,finality:'optimistic'}};
  const before=(await (await fetch(rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(query)})).json()).result;
  const mutation={jsonrpc:'2.0',id:'hostile',method:'sandbox_patch_state',params:{records:[{Account:{account_id:d.merchant.accountId,account:{amount:(BigInt(before.amount)+10n**24n).toString(),locked:before.locked,code_hash:before.code_hash,storage_usage:before.storage_usage}}}]}};
  for(const origin of ['http://127.0.0.1:49999','https://evil.example','null']){
   const pre=await fetch(rpc,{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'}});
   assert.equal(pre.headers.get('access-control-allow-origin'),null);await pre.body?.cancel();
   for(const type of ['text/plain','application/x-www-form-urlencoded','multipart/form-data']){
    const r=await fetch(rpc,{method:'POST',headers:{Origin:origin,'Content-Type':type},body:JSON.stringify(mutation)});
    assert.ok(!r.ok,`${origin} ${type} must be rejected before mutation`);await r.body?.cancel();
   }
  }
  assert.equal((await d.merchant.balance()).total.toString(),before.amount);
  for(const failure of ['before-reserve','after-reserve','before-execute','after-execute']){
   const invoice={id:failure,payee:d.merchant.accountId,asset:'near',amount:'1000000000000000000000'};
   await d.owner.call(d.vault,'authorize',{invoice});
   const initial=BigInt((await d.merchant.balance()).total.toString());let interrupted=false;
   const normal={call:(m:string,a:any)=>d.executor.call(d.vault,m,a,{gas:'100000000000000'}),view:(m:string,a:any)=>d.vault.view(m,a)};
   const flaky={...normal,async call(m:string,a:any){
    if(failure===`before-${m}`){interrupted=true;throw Error('injected interruption');}
    const result=await normal.call(m,a);
    if(failure===`after-${m}`){interrupted=true;throw Error('injected interruption');}return result;
   },async view(m:string,a:any){if(interrupted&&failure==='after-execute')throw Error('injected read interruption');return normal.view(m,a);}};
   const path=join(directory,failure+'.db');let adapters=vaultAdapters(flaky,invoice.id),ex=new Executor(path,adapters.auth,adapters.rail);
   await assert.rejects(()=>ex.execute(invoice,'original'),/injected/);ex.close();
   adapters=vaultAdapters(normal,invoice.id);const workers=Array.from({length:3},()=>new Executor(path,adapters.auth,adapters.rail));
   try{
    await Promise.all(workers.map(w=>w.execute(invoice,'original')));
    assert.equal(await workers[0].reconcile(invoice.id),'settled');
    assert.equal(BigInt((await d.merchant.balance()).total.toString())-initial,BigInt(invoice.amount));
    await assert.rejects(()=>workers[0].execute(invoice,'replacement'),/conflicting/);
   }finally{workers.forEach(w=>w.close());}
  }
 }finally{
  await d.close();
  try{const c=JSON.parse(readFileSync(join(directory,'chain.json'),'utf8'));if(c.pid)process.kill(c.pid,'SIGTERM');}catch{}
 }
});

test('a delayed vault read preserves the confirmed payment across restart', {timeout:120_000}, async () => {
 const desk = new SandboxDesk();
 const directory = mkdtempSync(join(tmpdir(), 'countersign-recovery-order-'));
 const journal = join(directory, 'attempts.db');
 try {
  await desk.start();
  const invoice = {id:'out-of-order', payee:desk.merchant.accountId, asset:'near', amount:parseNear('0.04')};
  const attempt = 'original';
  const args = {invoice_id:invoice.id};
  await desk.owner.call(desk.vault, 'authorize', {invoice});
  await desk.executor.call(desk.vault, 'reserve', {invoice, attempt_id:attempt});
  const tx = await desk.executor.callRaw(desk.vault, 'execute', {...args, attempt_id:attempt}, {gas:'100000000000000'});
  assert.equal(tx.failed, false);

  // Read the real pre-callback state at a receipt block, independent of RPC timing.
  let executing: Payment | undefined;
  for (const receipt of tx.result.receipts_outcome) {
   const read = await desk.worker.provider.viewCall(desk.vault.accountId, 'get_payment', args, {block_id:receipt.block_hash});
   const payment: Payment = JSON.parse(Buffer.from(read.result).toString());
   if (payment.state === 'Executing') { executing = payment; break; }
  }
  assert.ok(executing, 'expected to find the transfer in progress before its callback');
  const earlier = executing;
  const noWrite = async () => { throw Error('Reading a completed transfer must not send a transaction'); };
  const current = vaultAdapters({call:noWrite, view:(method, params) => desk.vault.view(method, params)}, invoice.id);
  const observer = new Executor(journal, current.auth, current.rail);
  const delayed = vaultAdapters({call:noWrite, async view() {
   assert.equal(await observer.reconcile(invoice.id), 'settled');
   return earlier; // Deliver the older response after the other worker saved the callback.
  }}, invoice.id);
  const worker = new Executor(journal, delayed.auth, delayed.rail);
  try {
   assert.equal(await worker.execute(invoice, attempt), 'settled');
  } finally { worker.close(); observer.close(); }

  const offline = vaultAdapters({call:noWrite, view:async () => { throw Error('Vault offline'); }}, invoice.id);
  const restarted = new Executor(journal, offline.auth, offline.rail);
  try {
   assert.equal(await restarted.execute(invoice, attempt), 'settled');
  } finally { restarted.close(); }
  assert.equal((await desk.snapshot()).merchantReceived, invoice.amount);
 } finally {
  await desk.close();
  rmSync(directory, {recursive:true});
 }
});
