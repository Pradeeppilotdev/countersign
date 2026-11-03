import {randomBytes} from 'node:crypto';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readVaultControls,replaceLocalExecutor} from '../app/vault-controls.ts';
import {SandboxDesk,parseNear} from '../app/sandbox.ts';
import {AgentInbox} from './inbox.ts';
import {demoProposer} from './demo-proposer.ts';
const [command,...args]=process.argv.slice(2);
const counts:Record<string,number[]>={init:[0],status:[0],policy:[3],revoke:[0],enqueue:[2],run:[1,2],resume:[0,1],'retry-proposal':[1],cancel:[1],'merchant-key':[2],'revoke-key':[1],import:[1],pause:[0],unpause:[0],'rotate-executor':[1]};
if(!counts[command]?.includes(args.length)||(command==='run'&&args[1]!==undefined&&args[1]!=='--live-model'))throw Error('Usage: agent:desk init | status | policy <per-payment NEAR> <rolling NEAR> <minutes> | revoke | enqueue <id> <NEAR> | run <id> [--live-model] | resume [id] | retry-proposal <id> | cancel <id> | merchant-key <merchant> <base64 public key> | revoke-key <merchant> | import <signed-invoice.json> | pause | unpause | rotate-executor <executor-local-label>');
const directory=resolve(process.env.COUNTERSIGN_AGENT_DIR??fileURLToPath(new URL('../work/agent-vault/',import.meta.url)));
if(command!=='init'&&!existsSync(join(directory,'desk.json')))throw Error('Initialize the separate local agent vault with agent:desk init first');
const desk=new SandboxDesk(directory,{recoverOnStart:false});let inbox:AgentInbox|undefined;
try{
 await desk.start();
 const transport={call:(method:string,body:any)=>desk.executor.call(desk.vault,method,body,{gas:'100000000000000'}),view:(method:string,body:any)=>desk.vault.view(method,body)};
 inbox=new AgentInbox(join(directory,'inbox.db'),`${desk.session}:${desk.vault.accountId}`,transport);
 let result:any;
 if(command==='pause'||command==='unpause'){result=await desk.owner.call(desk.vault,'set_paused',{paused:command==='pause'});}
 else if(command==='rotate-executor'){result=await replaceLocalExecutor(desk,args[0]);}
 else if(command==='merchant-key'||command==='revoke-key'){
  if(command==='merchant-key'){
   const key=Buffer.from(args[1],'base64');if(key.length!==32||key.toString('base64')!==args[1])throw Error('Expected a canonical base64 Ed25519 public key');
   if(!await desk.vault.view('get_invoice_domain',{}))await desk.owner.call(desk.vault,'configure_invoice_auth',{domain:randomBytes(32).toString('hex')});
  }
  result=await desk.owner.call(desk.vault,'set_merchant_key',{merchant_id:args[0],public_key:command==='merchant-key'?args[1]:null});
  result={...result,vault:desk.vault.accountId,domain:await desk.vault.view('get_invoice_domain',{})};
 }else if(command==='import'){
  if(statSync(args[0]).size>16384)throw Error('Signed invoice file too large');
  result=await inbox.enqueueSigned(JSON.parse(readFileSync(args[0],'utf8')),desk.vault.accountId);
 }else if(command==='policy'){
  const per=parseNear(args[0]),daily=parseNear(args[1]),minutes=Number(args[2]);
  if(!Number.isInteger(minutes)||minutes<1||minutes>1440||BigInt(daily)<BigInt(per))throw Error('Policy needs a positive cap, rolling allowance >= cap, and expiry from 1 to 1440 minutes');
  result=await desk.owner.call(desk.vault,'set_policy',{merchants:[{id:'local-merchant',payee:desk.merchant.accountId}],per_payment:per,daily_limit:daily,expires_at:String(Date.now()+minutes*60000)});
 }else if(command==='revoke'){await desk.owner.call(desk.vault,'revoke_policy',{});result={revoked:true};}
 else if(command==='enqueue')result=inbox.enqueue({id:args[0],payee:desk.merchant.accountId,asset:'near',amount:parseNear(args[1])},'local-merchant');
 else if(command==='run'){
  if((await readVaultControls(desk.vault))?.paused)throw Error('Vault payments paused');
  console.log(args[1]?'LIVE MODEL → SAVED POLICY → LOCAL TEST FUNDS ONLY':'FIXTURE MODEL → SAVED POLICY → LOCAL TEST FUNDS ONLY');
  result=await inbox.run(args[0],invoice=>demoProposer(args.slice(1)).propose(invoice));
 }else if(command==='resume'){
  result=[];const ids=args.length?args:inbox.list().filter(r=>r.state==='proposal_ready').map(r=>String(r.id));
  for(const id of ids){try{result.push(await inbox.resume(id));}catch{result.push(inbox.get(id));}}
 }else if(command==='cancel')result=await inbox.cancel(args[0],id=>desk.owner.call(desk.vault,'cancel',{invoice_id:id}));
 else if(command==='retry-proposal')result=inbox.retryProposal(args[0]);
 else result={controls:await readVaultControls(desk.vault),network:'LOCAL_SANDBOX',vault:desk.vault.accountId,merchant:desk.merchant.accountId,policy:await desk.vault.view('get_policy',{}),usage:await desk.vault.view('policy_usage',{}),available:await desk.vault.view('available_balance',{}),merchantReceived:(BigInt((await desk.merchant.balance()).total.toString())-desk.baseline).toString(),invoices:inbox.list()};
 console.log(JSON.stringify(result,null,2));
}finally{inbox?.close();await desk.close();}
