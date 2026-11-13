import {requireLocalDemo,parseDemoAmount,parseDemoRules,type CafeProgress,type DemoRules} from '../agent/demo-cafe.ts';
import {agentWebError} from '../agent/desk-web.ts';
export function createDemoRoute(deps:{network:()=>string|undefined;state:()=>Promise<unknown>;setup:()=>Promise<unknown>;receive:()=>Promise<unknown>;pay:(live:boolean,progress:CafeProgress)=>Promise<unknown>;faucet:()=>Promise<unknown>;walletFaucet:()=>Promise<unknown>;deposit:(amount:bigint)=>Promise<unknown>;setRules:(rules:DemoRules)=>Promise<unknown>;renewRules:()=>Promise<unknown>;retry:(id:string)=>Promise<unknown>;reset:()=>Promise<unknown>;modelReady:()=>boolean}){
 let busy=false;
 const progress:CafeProgress={running:false,completed:0,total:0,current:null};
 return async(method:string,path:string,input:unknown,bytes=0)=>{
  const fail=(status:number,error:string)=>({status,body:{ok:false,error}});
  try{requireLocalDemo(deps.network());}catch(error){return fail(403,agentWebError(error));}
  const action=path.slice('/api/demo/'.length);
  if(!['state','progress','setup','receive','pay-all','faucet','wallet-faucet','deposit','set-rules','renew-rules','retry','reset'].includes(action))return fail(404,'Not found');
  if(method!==(['state','progress'].includes(action)?'GET':'POST'))return fail(405,'Method not allowed');
  if(bytes>16384)return fail(413,'Request too large.');
  if(method==='POST'){
   if(!input||typeof input!=='object'||Array.isArray(input))return fail(400,'Invalid request.');
   if(action==='pay-all'){
    if(Object.keys(input).join(',')!=='live'||typeof (input as any).live!=='boolean')return fail(400,'Invalid live model choice.');
    if((input as any).live&&!deps.modelReady())return fail(400,'No model key configured');
   }else if(action==='deposit'){
    if(Object.keys(input).join(',')!=='amount'||typeof (input as any).amount!=='string')return fail(400,'Invalid request.');
   }else if(action==='set-rules'){
    const keys=Object.keys(input).sort().join(',');
    if(keys!=='daily_budget,hours,per_bill'||Object.values(input).some(v=>typeof v!=='string'))return fail(400,'Invalid request.');
   }else if(action==='retry'){
    if(Object.keys(input).join(',')!=='id'||typeof (input as any).id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test((input as any).id))return fail(400,'Invalid invoice reference.');
   }else if(Object.keys(input).length)return fail(400,'Invalid request.');
  }
  let amount=0n;
  if(action==='deposit'){try{amount=parseDemoAmount((input as any).amount);}catch(error){return fail(400,agentWebError(error));}}
  let rules:DemoRules|null=null;
  if(action==='set-rules'){try{rules=parseDemoRules(input as any);}catch(error){return fail(400,agentWebError(error));}}
  if(action==='progress')return {status:200,body:{ok:true,progress:{...progress,order:progress.order?[...progress.order]:undefined,results:progress.results?progress.results.map(r=>({...r})):undefined}}};
  if(busy)return fail(409,'A café operation is already in progress.');
  busy=true;
  try{
   const state=await (action==='state'?deps.state():action==='setup'?deps.setup():action==='receive'?deps.receive():action==='pay-all'?deps.pay((input as any).live,progress):action==='faucet'?deps.faucet():action==='wallet-faucet'?deps.walletFaucet():action==='deposit'?deps.deposit(amount):action==='set-rules'?deps.setRules(rules!):action==='renew-rules'?deps.renewRules():action==='retry'?deps.retry((input as any).id):deps.reset());
   return {status:200,body:{ok:true,state}};
  }catch(error){return fail(400,agentWebError(error));}
  finally{busy=false;}
 };
}
