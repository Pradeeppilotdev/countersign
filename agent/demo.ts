import {mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {SandboxDesk} from '../app/sandbox.ts';
import {InvoicePaymentTool,runInvoiceAgent} from './payment-tool.ts';
import {nearModelProposer,parseModelProposal} from './near-model.ts';

const flags=process.argv.slice(2);
if(flags.some(f=>f!=='--live-model')||flags.length>1)throw Error('Usage: npm run agent:demo -- [--live-model]');
const live=flags.includes('--live-model');
// Live inference is opt-in; default makes no external requests and uses no API key.
const propose=live?nearModelProposer({apiKey:process.env.NEAR_AI_API_KEY??'',model:process.env.NEAR_AI_MODEL??''}):async(invoice:any)=>parseModelProposal({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'request_payment',arguments:JSON.stringify({invoice_id:invoice.id})}}]}}]},invoice.id);
const desk=new SandboxDesk();
try{
 console.log(live?'LIVE MODEL → LOCAL TEST FUNDS ONLY':'FIXTURE MODEL RESPONSE → LOCAL TEST FUNDS ONLY');
 await desk.start();
 const invoice={id:'agent-demo',payee:desk.merchant.accountId,asset:'near',amount:'100000000000000000000000'};
 await desk.owner.call(desk.vault,'authorize',{invoice});
 const transport={call:(method:string,args:Record<string,unknown>)=>desk.executor.call(desk.vault,method,args,{gas:'100000000000000'}),view:(method:string,args:Record<string,unknown>)=>desk.vault.view(method,args)};
 mkdirSync(new URL('../work/',import.meta.url),{recursive:true});
 const path=fileURLToPath(new URL(`../work/agent-${desk.session}.db`,import.meta.url));
 const tool=new InvoicePaymentTool(path,`${desk.session}:${desk.vault.accountId}`,invoice,transport);
 const before=BigInt((await desk.merchant.balance()).total.toString());
 console.log('First request:',await runInvoiceAgent(invoice,propose,tool));
 console.log('Duplicate request:',await tool.request({invoice_id:invoice.id}));
 const delta=BigInt((await desk.merchant.balance()).total.toString())-before;
 if(delta!==BigInt(invoice.amount))throw Error('Unexpected merchant balance');
 console.log('Verified: merchant received exactly 0.1 local test NEAR; duplicate did not pay again.');
}finally{await desk.close();}
