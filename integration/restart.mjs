import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,existsSync} from 'node:fs';
import {request} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const cwd=fileURLToPath(new URL('../',import.meta.url));
const directory=mkdtempSync(join(tmpdir(),'countersign-restart-'));const port=await new Promise((resolve,reject)=>{const server=createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});const base=`http://127.0.0.1:${port}`;let child,logs='';
async function api(action='',data){const r=await fetch(base+'/api/sandbox'+(action?'/'+action:''),action?{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(data??{})}:{});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b;}
async function start(npm=false){
 child=spawn(npm?'npm':process.execPath,npm?['run','dev']:['--disable-warning=ExperimentalWarning','app/server.ts'],{
  cwd,detached:npm,env:{...process.env,COUNTERSIGN_PORT:String(port),COUNTERSIGN_SANDBOX_DIR:directory,
   COUNTERSIGN_AGENT_DIR:join(directory,'agent-vault'),COUNTERSIGN_WORKFLOW_DB:join(directory,'workflow.db'),COUNTERSIGN_NETWORK:'local',NEAR_AI_API_KEY:''},
  stdio:['ignore','pipe','pipe'],
 });
 child.npm=npm;child.log='';
 const p=child,record=d=>{logs+=d;p.log+=d;};
 p.stdout.on('data',record);p.stderr.on('data',record);
 p.closed=new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',(code,signal)=>resolve({code,signal}));});
 for(let i=0;i<160;i++){if(p.exitCode!==null||p.signalCode!==null)throw Error(logs);try{return await api();}catch{}await delay(250);}
 throw Error('App readiness timed out '+logs);
}
function signalApp(p,signal){
 // A terminal sends Ctrl-C to npm and its child; npm forwards it again.
 if(p.npm)process.kill(-p.pid,signal);else p.kill(signal);
}
async function exited(p){
 const timer=setTimeout(()=>{try{signalApp(p,'SIGKILL');}catch{}},20000);
 try{return await p.closed;}finally{clearTimeout(timer);}
}
async function stop(signal){
 const p=child;
 if(p.exitCode===null&&p.signalCode===null)signalApp(p,signal);
 const result=await exited(p);child=null;
 assert.deepEqual(result,signal==='SIGKILL'?{code:null,signal}:{code:0,signal:null},p.log);
 assert.doesNotMatch(p.log,/ERELEASED|Lock is already released|shutdown failed/);
 if(signal!=='SIGKILL')assert.equal(existsSync(directory+'.lock'),false,'graceful stop must release the vault lock');
}
async function stopDuringRequest(){
 // Hold an accepted request open so both signals reach the app while it drains.
 const p=child,body=JSON.stringify({id:'shutdown-queued',amount:'0.02'});
 let req;
 const continued=Promise.withResolvers();
 const response=new Promise((resolve,reject)=>{
  req=request(base+'/api/sandbox/authorize',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Expect:'100-continue','Content-Length':Buffer.byteLength(body)}},res=>{
   let value='';res.on('data',d=>value+=d);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(value)}));
  });
  req.on('error',error=>{continued.reject(error);reject(error);});
  req.setTimeout(30000,()=>req.destroy(Error('Shutdown request timed out')));
  req.on('continue',continued.resolve);req.flushHeaders();
 });
 try{
  await continued.promise;
  signalApp(p,'SIGINT');
  let stoppedListening=false;
  for(let i=0;i<80;i++){
   try{await fetch(base,{headers:{Connection:'close'},signal:AbortSignal.timeout(1000)});}catch{stoppedListening=true;break;}
   await delay(25);
  }
  assert.ok(stoppedListening,'the first signal must stop accepting connections');
  signalApp(p,'SIGTERM');await delay(50);
  assert.equal(p.exitCode,null,'accepted requests must drain before exit');
  assert.equal(p.signalCode,null);
  req.end(body);
  const result=await response;assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.invoices.find(i=>i.id==='shutdown-queued').state,'Authorized');
  assert.deepEqual(await exited(p),{code:0,signal:null},p.log);child=null;
  assert.doesNotMatch(p.log,/ERELEASED|Lock is already released|shutdown failed/);
  assert.equal(existsSync(directory+'.lock'),false);
 }finally{
  req.destroy();
  // An assertion failure also aborts the held request. Observe that rejection
  // so a secondary socket error cannot hide the original shutdown failure.
  await response.catch(()=>{});
 }
}
function attempts(){
 const db=new DatabaseSync(join(directory,'attempts.db'),{readOnly:true});
 try{return db.prepare('SELECT * FROM attempts ORDER BY invoice_id').all();}finally{db.close();}
}
async function checkAttackResults() {
 const desk = await fetch(base);
 assert.match(await desk.text(), /href="\/attack-results\/"/);
 for(const [asset,type] of [['/app.js','text/javascript'],['/sandbox.js','text/javascript'],['/components.js','text/javascript'],['/state.js','text/javascript'],['/style.css','text/css'],['/logo.svg','image/svg+xml'],['/fonts/manrope.ttf','font/ttf']]){
  const response=await fetch(base+asset);assert.equal(response.status,200,asset);assert.equal(response.headers.get('content-type'),type,asset);
  assert.ok((await response.arrayBuffer()).byteLength>0,asset);
 }
 const redirect = await fetch(base + '/attack-results', {redirect:'manual'});
 assert.equal(redirect.status, 308);
 assert.equal(redirect.headers.get('location'), '/attack-results/');
 const page = await fetch(base + '/attack-results/');
 assert.equal(page.status, 200);
 assert.match(page.headers.get('content-security-policy'),/img-src 'self'/);
 assert.match(page.headers.get('content-security-policy'),/font-src 'self'/);
 const article = await page.text();
 assert.ok(article.includes('npm run test:upgrade:weekly'));
 assert.ok(article.includes('href="result.json"'));
 const response = await fetch(new URL('result.json', page.url));
 assert.equal(response.status, 200);
 const report = await response.json();
 assert.equal(report.network, 'LOCAL_SANDBOX');
 assert.equal(report.result, 'PASS');
 const {base:before, paid, final, attempt, finalAttempts, winner, loser, signal, stateAtCrash} = report.weekly;
 assert.equal(signal, 'SIGKILL');
 assert.equal(stateAtCrash, 'claimed');
 assert.deepEqual([winner, loser].sort(), ['WEEK-A', 'WEEK-B']);
 assert.equal(BigInt(paid.merchantBalance) - BigInt(before.merchantBalance), 4n * 10n ** 22n);
 assert.equal(final.merchantBalance, paid.merchantBalance);
 assert.equal(final.available, paid.available);
 assert.equal(final.claim, winner);
 assert.deepEqual(finalAttempts, [{invoice_id:winner, attempt_id:attempt, state:'settled'}]);
 console.log('PASS: the desk links to the recorded weekly race, one 0.04 local test NEAR payment and zero extra on retry.');
}
try{
 const first=await start();assert.equal(first.available,'5000000000000000000000000');
 await checkAttackResults();
 await api('authorize',{id:'restart-1',amount:'0.1'});const reserved=await api('reserve',{id:'restart-1'});assert.equal(reserved.invoices[0].state,'Reserved');
 await stop('SIGKILL');const resumed=await start();assert.equal(resumed.vault,first.vault);assert.equal(resumed.session,first.session);assert.equal(resumed.available,reserved.available);assert.equal(resumed.invoices[0].attempt,reserved.invoices[0].attempt);
 const paid=await api('execute',{id:'restart-1'});assert.equal(paid.invoices[0].state,'Settled');assert.equal(paid.merchantReceived,'100000000000000000000000');
 const paidAttempts=attempts();assert.equal(paidAttempts.length,1);assert.equal(paidAttempts[0].state,'settled');
 await stop('SIGTERM');const restored=await start(true);assert.equal(restored.vault,first.vault);assert.equal(restored.invoices[0].state,'Settled');
 const repeat=await api('execute',{id:'restart-1'});assert.equal(repeat.merchantReceived,paid.merchantReceived);assert.equal(repeat.available,paid.available);
 const saved=JSON.parse(readFileSync(join(directory,'desk.json'),'utf8'));
 // This archived quote creates no swap or payment; its saved record must survive too.
 const replay=await fetch(base+'/api/replay',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'});
 assert.equal(replay.status,201);const recordedQuote=await replay.json();
 await stopDuringRequest();
 const npmRestarted=await start(true);
 for(const key of ['vault','session','available','merchantReceived'])assert.equal(npmRestarted[key],paid[key],key);
 assert.deepEqual(npmRestarted.invoices.find(i=>i.id==='restart-1'),paid.invoices[0]);
 assert.equal(npmRestarted.invoices.find(i=>i.id==='shutdown-queued').state,'Authorized');
 assert.deepEqual(attempts(),paidAttempts,'same settled attempt, no new payment');
 const persisted=JSON.parse(readFileSync(join(directory,'desk.json'),'utf8'));
 assert.deepEqual(persisted.events.slice(0,saved.events.length),saved.events);
 assert.deepEqual(await (await fetch(base+'/api/workflows')).json(),[recordedQuote]);
 console.log('PASS: npm Ctrl-C plus repeated stop signals drain the accepted request, release the lock once and retain bills, balances, attempts and recorded quotes.');
 await stop('SIGTERM');
 const previousChain=JSON.parse(readFileSync(join(directory,'chain.json'),'utf8'));process.kill(previousChain.pid,'SIGTERM');
 for(let i=0;i<80;i++){try{process.kill(previousChain.pid,0);}catch{break;}await new Promise(r=>setTimeout(r,100));}
 const chainRestarted=await start();assert.equal(chainRestarted.vault,first.vault);assert.equal(chainRestarted.merchantReceived,paid.merchantReceived);
 console.log('PASS: chain process restart preserves vault and balances.');
 console.log('PASS: full app SIGKILL/restart retains reservation; graceful restart retains settlement; replay does not pay twice.');
}catch(e){console.error(e);console.error(logs);process.exitCode=1;}finally{
 if(child)await stop('SIGTERM');
 try{const config=JSON.parse(readFileSync(join(directory,'chain.json'),'utf8'));if(config.pid)process.kill(config.pid,'SIGTERM');}catch{}
 // Chain data retained until its process exits; temporary test files can be inspected if needed.
}
