import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile,fork} from 'node:child_process';
import {promisify} from 'node:util';
import {SandboxDesk} from '../app/sandbox.ts';
const exec=promisify(execFile),cwd=fileURLToPath(new URL('../',import.meta.url));
test('persistent inbox survives process kills before and after proposal; resumes same vault and pays once',{timeout:240_000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'countersign-inbox-restart-'));
 const desk=new SandboxDesk(directory);let deskClosed=false;let child:ReturnType<typeof fork>|undefined;
 const cli=async(...args:string[])=>{
  const {stdout}=await exec(process.execPath,['--disable-warning=ExperimentalWarning','agent/desk.ts',...args],{cwd,env:{...process.env,COUNTERSIGN_AGENT_DIR:directory,NEAR_AI_API_KEY:'',NEAR_AI_MODEL:''},timeout:60000});
  const start=stdout.search(/^[\[{]/m);return JSON.parse(stdout.slice(start));
 };
 async function killAt(id:string,checkpoint:string){
  child=fork(join(cwd,'integration/helpers/inbox-worker.ts'),[directory,id,checkpoint],{cwd,execArgv:['--disable-warning=ExperimentalWarning'],stdio:['ignore','ignore','pipe','ipc']});
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Worker checkpoint timed out')),30000);
   child!.once('message',message=>{clearTimeout(timer);assert.equal(message,checkpoint==='inference'?'inference':'proposal_saved');resolve();});
   child!.once('exit',code=>{clearTimeout(timer);reject(Error(`Worker exited before checkpoint: ${code}`));});
  });
  await new Promise<void>(resolve=>{child!.once('exit',()=>resolve());child!.kill('SIGKILL');});child=undefined;
 }
 try{
  const initial=await cli('init'),vault=initial.vault;
  await cli('policy','0.1','0.15','60');
  for(const [id,amount] of [['saved','0.1'],['interrupted','0.04'],['cancel','0.01']])await cli('enqueue',id,amount);
  await desk.start();
  await desk.executor.call(desk.vault,'authorize_by_policy',{invoice:{id:'cancel',payee:desk.merchant.accountId,asset:'near',amount:'10000000000000000000000'},merchant_id:'local-merchant'});
  await desk.close();deskClosed=true;
  assert.equal((await cli('cancel','cancel')).state,'cancelled');
  assert.equal((await cli('run','cancel','--live-model')).state,'cancelled');
  await killAt('saved','proposal_saved');
  const paid=await cli('run','saved','--live-model'); // Empty credentials prove recovery never invokes inference.
  assert.equal(paid.state,'settled');
  assert.equal((await cli('run','saved','--live-model')).state,'settled');
  let state=await cli('status');assert.equal(state.vault,vault);assert.equal(state.merchantReceived,'100000000000000000000000');
  await killAt('interrupted','inference');
  const pending=await cli('status');assert.equal(pending.invoices.find((r:any)=>r.id==='interrupted').state,'inference_pending');
  await cli('resume','interrupted');state=await cli('status');assert.equal(state.merchantReceived,'100000000000000000000000');
  assert.equal((await cli('retry-proposal','interrupted')).state,'queued');
  assert.equal((await cli('run','interrupted')).state,'settled');
  state=await cli('status');assert.equal(state.merchantReceived,'140000000000000000000000');assert.equal(state.usage,state.merchantReceived);
  assert.equal((await cli('init')).usage,state.usage); // Re-initialization cannot reset policy history/fund another vault.
  console.log('PASS: saved proposal resumes after SIGKILL without model credentials; uncertain inference requires explicit retry; same vault pays once.');
 }finally{
  if(child&&child.exitCode===null){await new Promise(r=>{child!.once('exit',r);child!.kill('SIGKILL');});}
  if(!deskClosed)await desk.close();
  try{const chain=JSON.parse(readFileSync(join(directory,'chain.json'),'utf8'));process.kill(chain.pid,'SIGTERM');}catch{}
 }
});
