// POST /api/ask — read-only web entry to the Ask Dave CLI.
// The handler imports only agent/ask/views.ts and node built-ins;
// ask-route.test.ts guards that nothing else is imported here.
import {AskError,validAccount} from '../agent/ask/views.ts';

const NO_VAULT='No agent vault yet. Run npm run agent:desk -- init first.';
const BUSY='Ask Dave is busy, try again in a moment.';
const GENERIC="Ask Dave couldn't answer that.";

export type AskDeps={
  ask:(args:string[],dir:string)=>Promise<string>;
  agentDir:string;
  vaultExists:()=>boolean;
  now:()=>number;
};

let askInFlight=0, lastQuestionAt=-Infinity;

export async function handleAsk(
  input:unknown,
  deps:AskDeps,
):Promise<{status:number;body:{ok:boolean;text?:string;error?:string}}> {
  if(!input||typeof input!=='object'||Array.isArray(input))return {status:400,body:{ok:false,error:'Invalid request.'}};
  const kind=(input as {kind?:unknown}).kind;
  let args:string[]|null=null, question=false;
  if(kind==='question'){
    const text=(input as {text?:unknown}).text;
    if(typeof text!=='string')return {status:400,body:{ok:false,error:'Invalid question.'}};
    const trimmed=text.trim();
    if(trimmed.length<1||trimmed.length>500||trimmed.startsWith('-'))
      return {status:400,body:{ok:false,error:'Invalid question.'}};
    args=[trimmed];question=true;
  }else if(kind==='account'){
    const account=(input as {account?:unknown}).account;
    if(!validAccount(account))return {status:400,body:{ok:false,error:'Invalid account.'}};
    args=['--account',account];
  }else return {status:400,body:{ok:false,error:'Invalid request.'}};
  if(!deps.vaultExists())return {status:200,body:{ok:false,error:NO_VAULT}};
  if(question){
    // One question in flight, and no faster than one per 5000 ms. Account checks are never rate-limited.
    const now=deps.now();
    if(askInFlight>0||now-lastQuestionAt<5000)return {status:429,body:{ok:false,error:BUSY}};
    lastQuestionAt=now;askInFlight++;
  }
  try{
    const text=await deps.ask(args,deps.agentDir);
    return {status:200,body:{ok:true,text}};
  }catch(error){
    if(error instanceof AskError)return {status:200,body:{ok:false,error:error.message}};
    console.error(error);
    return {status:500,body:{ok:false,error:GENERIC}};
  }finally{
    if(question)askInFlight--;
  }
}
