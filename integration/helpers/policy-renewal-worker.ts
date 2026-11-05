// Test-only crash checkpoint around the actual owner CLI. Production exposes no
// fault switch and the model never receives the owner's renewal capability.
import {Account} from 'near-workspaces';
const [directory,id]=process.argv.slice(2);
process.env.COUNTERSIGN_AGENT_DIR=directory;
process.env.NEAR_AI_API_KEY='';
const call=Account.prototype.call;
Account.prototype.call=async function(...args:any[]){
 const result=await call.apply(this,args as any);
 if(args[1]==='renew_policy'){
  process.send?.('renewal_accepted');
  await new Promise(()=>{});
 }
 return result;
};
process.argv=[process.execPath,'agent/desk.ts','renew-policy','60',id];
await import('../../agent/desk.ts');
