import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {generateKeyPairSync,randomBytes} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {SandboxDesk,parseNear} from '../app/sandbox.ts';
import {signInvoice,publicKeyBase64} from '../merchant/invoice.ts';

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL('../', import.meta.url));

test('owner cancel rejects both signed ID collisions and reconciles a killed CLI without releasing twice', {timeout:180_000}, async () => {
 const directory = mkdtempSync(join(tmpdir(), 'countersign-signed-cancel-'));
 const desk = new SandboxDesk(directory, {recoverOnStart:false});
 const cli = async (args:string[], crashAfterCancel=false) => {
  const preload = crashAfterCancel ? ['--import','./integration/helpers/crash-after-owner-call.ts'] : [];
  const {stdout} = await exec(process.execPath, ['--disable-warning=ExperimentalWarning',...preload,'agent/desk.ts',...args], {
   cwd, env:{...process.env, COUNTERSIGN_AGENT_DIR:directory, NEAR_AI_API_KEY:'', NEAR_AI_MODEL:''}, timeout:60_000,
  });
  return JSON.parse(stdout);
 };
 const localState = (id:string) => {
  const db = new DatabaseSync(join(directory,'inbox.db'), {readOnly:true});
  try { return {...db.prepare('SELECT state,generation FROM inbox WHERE id=?').get(id)}; }
  finally { db.close(); }
 };
 try {
  await desk.start();
  const {owner,executor,vault,merchant} = desk;
  const cups = await desk.worker.rootAccount.createSubAccount('cups');
  const beans = {id:'beans',payee:merchant.accountId,key:generateKeyPairSync('ed25519')};
  const other = {id:'cups',payee:cups.accountId,key:generateKeyPairSync('ed25519')};
  const amount = parseNear('0.04'), domain = randomBytes(32).toString('hex');
  const now = BigInt((await vault.view('policy_snapshot',{})).now);
  const policy = {merchants:[beans,other].map(({id,payee})=>({id,payee})),per_payment:parseNear('0.1'),daily_limit:parseNear('1'),expires_at:String(now+3_600_000n)};
  await owner.call(vault,'set_policy',policy);
  await owner.call(vault,'configure_invoice_auth',{domain});
  for (const supplier of [beans,other]) {
   await owner.call(vault,'set_merchant_key',{merchant_id:supplier.id,public_key:publicKeyBase64(supplier.key.publicKey)});
  }
  const sign = (id:string,supplier:typeof beans,bill_id:string) => signInvoice({
   invoice:{id,payee:supplier.payee,asset:'near',amount}, merchant_id:supplier.id, bill_id, vault:vault.accountId,
   domain, key_version:'1', expires_at:String(now+1_800_000n),
  }, supplier.key.privateKey);
  const payment = (id:string) => vault.view('get_payment',{invoice_id:id});
  const available = () => vault.view('available_balance',{});
  const usage = () => vault.view('policy_usage',{});
  const balances = () => Promise.all([merchant,cups].map(async account => (await account.balance()).total.toString()));
  const initialAvailable = await available(), initialBalances = await balances();
  const differentSupplier = sign('shared-id',beans,'beans-original');
  const differentBill = sign('same-terms',beans,'original-reference');
  const correct = sign('exact-bill',beans,'exact-reference');
  const originals = [differentSupplier,differentBill,correct];
  for (const signed of originals) await executor.call(vault,'authorize_signed_invoice',{signed},{gas:'100000000000000'});
  await executor.call(vault,'reserve',{invoice:correct.invoice,attempt_id:'original-attempt'});
  const heldBalance = (BigInt(initialAvailable)-BigInt(amount)).toString();
  assert.equal(await available(), heldBalance);
  assert.equal(await usage(), parseNear('0.12'));
  const receipt = await vault.view('get_invoice_auth',{invoice_id:correct.invoice.id});
  await desk.close(); // Let separate CLI processes acquire the saved desk lock.

  const imported = [sign(differentSupplier.invoice.id,other,'cups-bill'),sign(differentBill.invoice.id,beans,'different-reference'),correct];
  for (const bill of imported) {
   const file = join(directory,bill.invoice.id+'.json');
   writeFileSync(file,JSON.stringify(bill),{mode:0o600});
   assert.equal((await cli(['import',file])).state,'queued');
  }
  for (const signed of [differentSupplier,differentBill]) {
   const id = signed.invoice.id, original = await payment(id);
   assert.equal(original.state,'Authorized');
   await assert.rejects(()=>cli(['cancel',id],true),(error:any)=>{
    assert.equal(error.code,1);
    assert.match(error.stderr,/different terms|differs from the vault authorization/);
    return true;
   });
   assert.deepEqual(await payment(id),original);
   assert.deepEqual(localState(id),{state:'queued',generation:0});
   assert.equal(await usage(),parseNear('0.12'));
   assert.equal(await available(),heldBalance);
  }

  // A policy replacement makes the reserved bill eligible for owner cancellation.
  await owner.call(vault,'set_policy',policy);
  const id = correct.invoice.id;
  assert.equal((await payment(id)).state,'Reserved');
  assert.equal(await usage(),parseNear('0.12'));
  await assert.rejects(()=>cli(['cancel',id],true),(error:any)=>error.signal==='SIGKILL');
  assert.deepEqual(localState(id),{state:'queued',generation:0});
  const cancelled = await payment(id);
  assert.equal(cancelled.state,'Cancelled');
  assert.equal(cancelled.attempt_id,'original-attempt');
  assert.equal(await usage(),parseNear('0.08'));
  assert.equal(await available(),initialAvailable);

  // The same preload would kill either retry if it sent another cancellation.
  for (let n=0;n<2;n++) {
   const row = await cli(['cancel',id],true);
   assert.equal(row.state,'cancelled');
   assert.equal(row.generation,1);
   assert.deepEqual(row.signed_invoice,correct);
   assert.deepEqual(await payment(id),cancelled);
   assert.deepEqual(await vault.view('get_invoice_auth',{invoice_id:id}),receipt);
   assert.equal(await usage(),parseNear('0.08'));
   assert.equal(await available(),initialAvailable);
  }
  assert.deepEqual(await balances(),initialBalances);

  // Explicit bulk cleanup still reconciles matching rows past colliding inbox IDs.
  const bulk = sign('bulk-match',beans,'bulk-reference');
  await executor.call(vault,'authorize_signed_invoice',{signed:bulk},{gas:'100000000000000'});
  const file = join(directory,'bulk.json');
  writeFileSync(file,JSON.stringify(bulk),{mode:0o600});
  await cli(['import',file]);
  const cleared = await cli(['clear-approvals']);
  assert.deepEqual(cleared.sort(),[bulk.invoice.id,differentBill.invoice.id,differentSupplier.invoice.id].sort());
  assert.equal(localState(bulk.invoice.id).state,'cancelled');
  for (const otherBill of [differentSupplier,differentBill]) assert.equal(localState(otherBill.invoice.id).state,'queued');
 } finally {
  await desk.close();
  try {process.kill(JSON.parse(readFileSync(join(directory,'chain.json'),'utf8')).pid,'SIGTERM');} catch {}
 }
});
