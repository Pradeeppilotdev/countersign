// One plain chat completion for Ask Dave. The request defines no tools, so the
// model has nothing it could call: it can only return text for the code to check.
import {existsSync,readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {AskError} from './views.ts';

const ENDPOINT='https://cloud-api.near.ai/v1/chat/completions';
export const MAX_TOKENS=2000; // Reasoning models stall when the budget is small.
export type ChatMessage={role:'system'|'user';content:string};
export type Complete=(messages:ChatMessage[])=>Promise<string>;

export function modelConfig(){
 // Read only the two inference settings from the ignored .env.
 const path=new URL('../../.env',import.meta.url);
 const local=existsSync(path)?parseEnv(readFileSync(path,'utf8')):{};
 return {apiKey:process.env.NEAR_AI_API_KEY??local.NEAR_AI_API_KEY??'',model:process.env.NEAR_AI_MODEL??local.NEAR_AI_MODEL??''};
}

export function nearChat(config:{apiKey:string;model:string},send:typeof fetch=fetch):Complete{
 if(!config.apiKey?.trim()||!config.model?.trim())throw new AskError('Set NEAR_AI_API_KEY and NEAR_AI_MODEL before asking a question.');
 const {apiKey,model}=config;
 return async messages=>{
  let response:Response;
  try{
   response=await send(ENDPOINT,{method:'POST',redirect:'error',signal:AbortSignal.timeout(90_000),
    headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({model,stream:false,max_tokens:MAX_TOKENS,temperature:0,messages})});
  }catch{throw new AskError('Ask Dave: the model request failed.');}
  if(!response.ok){await response.body?.cancel();throw new AskError(`Ask Dave: the model request failed (HTTP ${response.status}).`);}
  let body:any;
  try{
   const text=await response.text();
   if(text.length>262144)throw Error('oversized');
   body=JSON.parse(text);
  }catch{throw new AskError('Ask Dave: the model reply was unreadable.');}
  const content=body?.choices?.[0]?.message?.content;
  // Truncated or empty output is handed on as-is and fails the answer check.
  return typeof content==='string'?content:'';
 };
}
