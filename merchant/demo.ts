import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {signInvoice,publicKeyBase64} from './invoice.ts';
const flags=process.argv.slice(2);
if(flags.length>1||flags.some(f=>f!=='--live-model'))throw Error('Only --live-model is supported; payments are local test funds only');
const directory=mkdtempSync(join(tmpdir(),'countersign-signed-demo-')),exec=promisify(execFile),cwd=fileURLToPath(new URL('../',import.meta.url));
async function desk(...args:string[]){
 const {stdout}=await exec(process.execPath,['--disable-warning=ExperimentalWarning','agent/desk.ts',...args],{cwd,env:{...process.env,COUNTERSIGN_AGENT_DIR:directory},timeout:90000});
 return JSON.parse(stdout.slice(stdout.search(/^[\[{]/m)));
}
try{
 const state=await desk('init');await desk('policy','0.1','0.15','60');
 // Fixture merchant identity. Private key stays in this process, never in the agent child or model.
 const pair=generateKeyPairSync('ed25519');
 const key=await desk('merchant-key','local-merchant',publicKeyBase64(pair.publicKey));
 const signed=signInvoice({invoice:{id:'SIGNED-001',payee:state.merchant,asset:'near',amount:'100000000000000000000000'},merchant_id:'local-merchant',bill_id:'merchant-bill-001',vault:state.vault,domain:key.domain,key_version:key.version,expires_at:String(Date.now()+600000)},pair.privateKey);
 const file=join(directory,'signed-invoice.json');
 writeFileSync(file,JSON.stringify({...signed,invoice:{...signed.invoice,amount:'200000000000000000000000'}}),{mode:0o600});
 await assert.rejects(()=>desk('import',file),/Invalid merchant signature/);
 writeFileSync(file,JSON.stringify(signed),{mode:0o600});
 assert.equal((await desk('import',file)).state,'queued');
 assert.equal((await desk('run','SIGNED-001',...flags)).state,'settled');
 assert.equal((await desk('run','SIGNED-001',...flags)).state,'settled');
 const after=await desk('status');assert.equal(after.merchantReceived,signed.invoice.amount);assert.equal(after.usage,signed.invoice.amount);
 console.log('PASS: forged amount rejected before intake; merchant-signed invoice imported and paid exactly 0.1 local test NEAR.');
 console.log('PASS: signature verified on chain; duplicate paid nothing; policy usage retained.');
 console.log(flags.length?'One live model request; disposable local payment funds only.':'Fixture model only; no inference credits, swaps or real funds.');
 console.log('Disposable verification records:',directory);
}finally{
 try{const config=JSON.parse(readFileSync(join(directory,'chain.json'),'utf8'));process.kill(config.pid,'SIGTERM');}catch{}
}
