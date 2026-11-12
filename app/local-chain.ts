import {hardenSandbox,assertBrowserBlocked} from './sandbox-config.mjs';
import {SandboxManager,KeyPair} from 'near-workspaces';
import {spawn,execFileSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';

export function saveJson(path:string,data:unknown){
 const temp=path+'.tmp';const fd=openSync(temp,'w',0o600);
 try{writeFileSync(fd,JSON.stringify(data));fsyncSync(fd);}finally{closeSync(fd);}
 renameSync(temp,path);
 const directory=openSync(join(path,'..'),'r');try{fsyncSync(directory);}finally{closeSync(directory);}
}
async function freePort():Promise<number>{return new Promise((resolve,reject)=>{const s=createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=(s.address() as any).port;s.close(()=>resolve(port));});});}
export async function localChain(directory:string){
 mkdirSync(directory,{recursive:true,mode:0o700});
 const path=join(directory,'chain.json');const binary=fileURLToPath(new URL('../work/sandbox-bin/near-sandbox',import.meta.url));
 let config:any;
 if(existsSync(path))config=JSON.parse(readFileSync(path,'utf8'));
 else{
  const homeDir=join(directory,'chain');
  if(existsSync(homeDir))throw Error('Incomplete local chain initialization; refusing to replace existing data.');
  execFileSync(binary,['--home',homeDir,'init'],{stdio:'ignore'});
  config={network:'sandbox',rootAccountId:'test.near',homeDir,port:await freePort(),peerPort:await freePort()};
  saveJson(path,config);
 }
 if(config.network!=='sandbox'||config.rootAccountId!=='test.near'||config.homeDir!==join(directory,'chain')||![config.port,config.peerPort].every(p=>Number.isInteger(p)&&p>1024&&p<65536))throw Error('Invalid local chain configuration');
 hardenSandbox(config.homeDir);
 const rpcAddr=`http://127.0.0.1:${config.port}`;
 async function status(){try{const r=await fetch(rpcAddr,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'countersign',method:'status',params:[]}),signal:AbortSignal.timeout(1500)});return (await r.json()).result;}catch{return null;}}
 let current=await status();
 if(!current){
  const fd=openSync(join(directory,'chain.log'),'a',0o600);
  const child=spawn(binary,['--home',config.homeDir,'run','--rpc-addr',`127.0.0.1:${config.port}`,'--network-addr',`127.0.0.1:${config.peerPort}`],{detached:true,stdio:['ignore',fd,fd]});
  closeSync(fd);child.unref();let spawnError=false;child.on('error',()=>{spawnError=true;});
  for(let i=0;i<120&&!current;i++){if(spawnError||child.exitCode!==null)throw Error('Local chain failed to start; existing data retained');await new Promise(r=>setTimeout(r,250));current=await status();}
  if(!current)throw Error('Local chain unavailable; existing data retained');
  config.pid=child.pid;
 }
 await assertBrowserBlocked(rpcAddr);
 if(config.chainId&&config.chainId!==current.chain_id)throw Error('Local chain identity mismatch');
 config.chainId=current.chain_id;saveJson(path,config);
 const manager=new SandboxManager({...config,rpcAddr,rm:false,refDir:null});
 // Read fresh bytes after a café reset. The SDK's getKeyFromFile uses require(),
 // which caches validator_key.json from the previous chain at the same path.
 if(!await manager.getKey(config.rootAccountId)){
  const validator=JSON.parse(readFileSync(join(config.homeDir,'validator_key.json'),'utf8'));
  await manager.setKey(config.rootAccountId,KeyPair.fromString(validator.secret_key??validator.private_key));
 }
 await manager.init();
 return {rootAccount:manager.root,provider:manager.provider,account:(id:string)=>manager.getAccount(id),tearDown:async()=>{}};
}
