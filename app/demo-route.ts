import {requireLocalDemo,type CafeProgress} from '../agent/demo-cafe.ts';
import {agentWebError} from '../agent/desk-web.ts';
export function createDemoRoute(deps:{network:()=>string|undefined;state:()=>Promise<unknown>;setup:()=>Promise<unknown>;receive:()=>Promise<unknown>;pay:(live:boolean,progress:CafeProgress)=>Promise<unknown>;faucet:()=>Promise<unknown>;reset:()=>Promise<unknown>;modelReady:()=>boolean}){
 let busy=false;
 const progress:CafeProgress={running:false,completed:0,total:0,current:null};
 return async(method:string,path:string,input:unknown,bytes=0)=>{
  const fail=(status:number,error:string)=>({status,body:{ok:false,error}});
  try{requireLocalDemo(deps.network());}catch(error){return fail(403,agentWebError(error));}
  const action=path.slice('/api/demo/'.length);
  if(!['state','progress','setup','receive','pay-all','faucet','reset'].includes(action))return fail(404,'Not found');
  if(method!==(['state','progress'].includes(action)?'GET':'POST'))return fail(405,'Method not allowed');
  if(bytes>16384)return fail(413,'Request too large.');
  if(method==='POST'){
   if(!input||typeof input!=='object'||Array.isArray(input))return fail(400,'Invalid request.');
   if(action==='pay-all'){
    if(Object.keys(input).join(',')!=='live'||typeof (input as any).live!=='boolean')return fail(400,'Invalid live model choice.');
    if((input as any).live&&!deps.modelReady())return fail(400,'No model key configured');
   }else if(Object.keys(input).length)return fail(400,'Invalid request.');
  }
  if(action==='progress')return {status:200,body:{ok:true,progress:{...progress}}};
  if(busy)return fail(409,'A café operation is already in progress.');
  busy=true;
  try{
   const state=await (action==='state'?deps.state():action==='setup'?deps.setup():action==='receive'?deps.receive():action==='pay-all'?deps.pay((input as any).live,progress):action==='faucet'?deps.faucet():deps.reset());
   return {status:200,body:{ok:true,state}};
  }catch(error){return fail(400,agentWebError(error));}
  finally{busy=false;}
 };
}
