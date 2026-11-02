import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const cwd=fileURLToPath(new URL('../',import.meta.url));
const directory=mkdtempSync(join(tmpdir(),'countersign-restart-'));const port=await new Promise((resolve,reject)=>{const server=createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});const base=`http://127.0.0.1:${port}`;let child,logs='';
async function api(action='',data){const r=await fetch(base+'/api/sandbox'+(action?'/'+action:''),action?{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(data??{})}:{});const b=await r.json();assert.equal(r.status,200,JSON.stringify(b));return b;}
async function start(){child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','app/server.ts'],{cwd,env:{...process.env,COUNTERSIGN_PORT:String(port),COUNTERSIGN_SANDBOX_DIR:directory},stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);for(let i=0;i<160;i++){if(child.exitCode!==null)throw Error(logs);try{return await api();}catch{}await new Promise(r=>setTimeout(r,250));}throw Error('App readiness timed out '+logs);}
async function stop(signal){const p=child;if(p.exitCode!==null){child=null;return;}await new Promise(resolve=>{p.once('exit',resolve);p.kill(signal);});child=null;}
try{
 const first=await start();assert.equal(first.available,'5000000000000000000000000');
 await api('authorize',{id:'restart-1',amount:'0.1'});const reserved=await api('reserve',{id:'restart-1'});assert.equal(reserved.invoices[0].state,'Reserved');
 await stop('SIGKILL');const resumed=await start();assert.equal(resumed.vault,first.vault);assert.equal(resumed.session,first.session);assert.equal(resumed.available,reserved.available);assert.equal(resumed.invoices[0].attempt,reserved.invoices[0].attempt);
 const paid=await api('execute',{id:'restart-1'});assert.equal(paid.invoices[0].state,'Settled');assert.equal(paid.merchantReceived,'100000000000000000000000');
 await stop('SIGTERM');const restored=await start();assert.equal(restored.vault,first.vault);assert.equal(restored.invoices[0].state,'Settled');
 const repeat=await api('execute',{id:'restart-1'});assert.equal(repeat.merchantReceived,paid.merchantReceived);assert.equal(repeat.available,paid.available);
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
