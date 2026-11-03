import {existsSync,readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {nearModelProposer,parseModelProposal} from './near-model.ts';
import type {Invoice} from '../executor/core.ts';

function liveConfig(){
 // Read only the inference settings. Never export secrets into child-chain environments.
 const path=new URL('../.env',import.meta.url);
 const local=existsSync(path)?parseEnv(readFileSync(path,'utf8')):{};
 return {apiKey:process.env.NEAR_AI_API_KEY??local.NEAR_AI_API_KEY??'',model:process.env.NEAR_AI_MODEL??local.NEAR_AI_MODEL??''};
}
export function demoProposer(flags:string[],readConfig=liveConfig){
 if(flags.length>1||flags.some(f=>f!=='--live-model'))throw Error('Only --live-model is supported; payments always use a fresh local test chain');
 const live=flags.includes('--live-model');
 if(live){const config=readConfig();return {live,model:config.model,propose:nearModelProposer(config)};}
 return {live,model:'fixture',propose:async(invoice:Readonly<Invoice>)=>parseModelProposal({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',function:{name:'request_payment',arguments:JSON.stringify({invoice_id:invoice.id})}}]}}]},invoice.id)};
}
