import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
export function hardenSandbox(home){
 const path=join(home,'config.json'),config=JSON.parse(readFileSync(path,'utf8'));
 config.rpc.cors_allowed_origins=[];
 config.rpc.addr='127.0.0.1:3030';
 if(config.network)config.network.addr='127.0.0.1:24567';
 writeFileSync(path,JSON.stringify(config,null,2),{mode:0o600});
}
export async function assertBrowserBlocked(rpc){
 const preflight=await fetch(rpc,{method:'OPTIONS',headers:{Origin:'http://countersign.invalid','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'},signal:AbortSignal.timeout(3000)});
 const browserAllowed=preflight.headers.has('access-control-allow-origin');await preflight.body?.cancel();
 const response=await fetch(rpc,{method:'POST',headers:{Origin:'http://countersign.invalid','Content-Type':'text/plain'},body:JSON.stringify({jsonrpc:'2.0',id:'origin-check',method:'status',params:[]}),signal:AbortSignal.timeout(3000)});
 await response.body?.cancel();
 if(browserAllowed||response.ok)throw Error('Existing local chain permits browser-origin RPC. Stop its process and restart the app to apply the protection; data is retained.');
}
