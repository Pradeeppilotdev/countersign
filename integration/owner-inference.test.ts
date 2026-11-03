import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile,fork} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),cwd=fileURLToPath(new URL('../',import.meta.url));
test('owner can pause, rotate and revoke during inference; late proposals recheck the vault and never pay twice',{timeout:240000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'countersign-owner-inference-'));
 let child:ReturnType<typeof fork>|undefined;
 const cli=async(...args:string[])=>{const {stdout}=await exec(process.execPath,['--disable-warning=ExperimentalWarning','agent/desk.ts',...args],{cwd,env:{...process.env,COUNTERSIGN_AGENT_DIR:directory,NEAR_AI_API_KEY:'',NEAR_AI_MODEL:''},timeout:45000});return JSON.parse(stdout.slice(stdout.search(/^[\[{]/m)));};
 const message=(predicate:(value:any)=>boolean)=>new Promise<any>((resolve,reject)=>{
  const current=child!;const timer=setTimeout(()=>{cleanup();reject(Error('Inference checkpoint timed out'));},60000);
  const onMessage=(value:any)=>{if(predicate(value)){cleanup();resolve(value);}};
  const onExit=(code:number|null)=>{cleanup();reject(Error(`Worker exited before checkpoint: ${code}`));};
  function cleanup(){clearTimeout(timer);current.off('message',onMessage);current.off('exit',onExit);current.off('error',onError);}
  const onError=(error:Error)=>{cleanup();reject(error);};
  current.on('message',onMessage);current.once('exit',onExit);current.once('error',onError);
 });
 async function begin(id:string){
  await cli('enqueue',id,'0.1');
  child=fork(join(cwd,'integration/helpers/owner-inference-worker.ts'),[directory,id],{cwd,env:{...process.env,NEAR_AI_API_KEY:'',NEAR_AI_MODEL:''},execArgv:['--disable-warning=ExperimentalWarning'],stdio:['ignore','ignore','ignore','ipc']});
  await message(v=>v==='inference');
 }
 async function finish(){
  const result=message(v=>v&&typeof v==='object');
  const exited=new Promise<void>(resolve=>child!.once('exit',()=>resolve()));
  child!.send('complete');const value=await result;await exited;child=undefined;return value;
 }
 try{
  await cli('init');await cli('policy','0.1','0.3','60');
  await begin('paused');
  assert.equal((await cli('pause')).paused,true); // Must finish while the proposer is still blocked.
  const paused=await cli('status');assert.equal(paused.merchantReceived,'0');
  assert.equal(paused.invoices.find((i:any)=>i.id==='paused').state,'inference_pending');
  await cli('rotate-executor','executor-during-inference-1');
  assert.match((await finish()).error,/Vault payments paused/);
  assert.equal((await cli('status')).invoices[0].state,'proposal_ready');
  await cli('unpause');
  assert.equal((await cli('run','paused','--live-model')).state,'settled'); // Empty credentials: reuse the saved proposal.
  assert.equal((await cli('run','paused','--live-model')).state,'settled');

  await begin('rotated');await cli('pause');
  const rotated=await cli('rotate-executor','executor-during-inference-2');await cli('unpause');
  assert.equal((await finish()).state,'settled'); // Reconnect must pick up the replacement signer.
  let state=await cli('status');assert.equal(state.controls.executor,rotated.executor);
  assert.equal(state.merchantReceived,'200000000000000000000000');assert.equal(state.usage,state.merchantReceived);

  await begin('revoked');await cli('revoke');
  assert.match((await finish()).error,/no spending policy/);
  state=await cli('status');assert.equal(state.merchantReceived,'200000000000000000000000');
  assert.equal(state.invoices.find((i:any)=>i.id==='revoked').state,'proposal_ready');

  await begin('changed-vault');
  const path=join(directory,'desk.json'),saved=JSON.parse(readFileSync(path,'utf8'));
  writeFileSync(path,JSON.stringify({...saved,session:'changed-while-inference-was-running'}));
  assert.match((await finish()).error,/Vault identity changed during inference/);
  // Restore only this test fixture's identity so we can inspect unchanged balances.
  writeFileSync(path,JSON.stringify(saved));
  assert.equal((await cli('status')).merchantReceived,'200000000000000000000000');
  console.log('PASS: owner controls complete during blocked inference; paused, revoked and changed-vault proposals cannot pay; executor rotation resumes once.');
 }finally{
  if(child&&child.exitCode===null)await new Promise<void>(resolve=>{child!.once('exit',()=>resolve());child!.kill('SIGKILL');});
  try{process.kill(JSON.parse(readFileSync(join(directory,'chain.json'),'utf8')).pid,'SIGTERM');}catch{}
 }
});
