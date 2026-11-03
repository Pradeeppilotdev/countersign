// Explicit local-only code upgrade. Never resets chain state or imports user wallets.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import lockfile from 'proper-lockfile';
import {localChain} from './local-chain.ts';
const directory=resolve(process.env.COUNTERSIGN_SANDBOX_DIR ?? fileURLToPath(new URL('../work/local-vault/',import.meta.url)));
if(!existsSync(join(directory,'desk.json')))throw Error('No existing local vault to upgrade. Start a new desk normally.');
const unlock=await lockfile.lock(directory,{retries:0});
try{
 const saved=JSON.parse(readFileSync(join(directory,'desk.json'),'utf8'));
 const config=JSON.parse(readFileSync(join(directory,'chain.json'),'utf8'));
 if(config.network!=='sandbox'||config.homeDir!==join(directory,'chain'))throw Error('Only the saved local sandbox can be upgraded');
 // Restart the existing chain to apply origin restrictions. Never kill a reused PID.
 if(config.pid){
  let command='';try{command=execFileSync('ps',['-p',String(config.pid),'-o','command=']).toString();}catch{}
  if(command){
   if(!command.includes('near-sandbox')||!command.includes(config.homeDir))throw Error('Saved process identity changed; refusing to stop it');
   process.kill(config.pid,'SIGTERM');
   for(let n=0;n<100;n++){try{process.kill(config.pid,0);}catch{break;}await new Promise(r=>setTimeout(r,100));}
  }
 }
 const chain=await localChain(directory),vault=chain.account(saved.vault);
 const before=await vault.view('available_balance',{});
 const records=await Promise.all(saved.invoices.map(([id]:[string])=>vault.view('get_payment',{invoice_id:id})));
 const response=await fetch(chain.provider.connection.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'backup',method:'query',params:{request_type:'view_code',account_id:saved.vault,finality:'final'}})});
 const old=await response.json();if(!old.result?.code_base64)throw Error('Cannot back up existing code');
 const backup=join(directory,`vault-before-upgrade-${Date.now()}.wasm`);
 writeFileSync(backup,Buffer.from(old.result.code_base64,'base64'),{mode:0o600});
 await vault.deploy(fileURLToPath(new URL('../contract/target/wasm32-unknown-unknown/release/countersign.wasm',import.meta.url)));
 if(await vault.view('available_balance',{})!==before)throw Error('Upgrade accounting verification failed');
 for(const [n,[id]] of saved.invoices.entries())if(JSON.stringify(await vault.view('get_payment',{invoice_id:id}))!==JSON.stringify(records[n]))throw Error('Upgrade invoice verification failed');
 console.log('Local vault upgraded; invoice records and available budget preserved.');console.log('Previous code backup:',backup);
}finally{await unlock();}
