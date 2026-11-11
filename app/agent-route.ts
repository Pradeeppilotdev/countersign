// HTTP validation only. The server injects the shared desk operations.
export type AgentDeps={
 state:()=>Promise<unknown>;
 importBill:(invoice:unknown)=>Promise<unknown>;
 run:(id:string,live:boolean)=>Promise<unknown>;
 resume:(id:string)=>Promise<unknown>;
 modelReady:()=>boolean;
 error:(error:unknown)=>string;
};
export const AGENT_BODY_LIMIT=16384;
export function createAgentRoute(deps:AgentDeps){
 let running=false;
 const fail=(status:number,error:string)=>({status,body:{ok:false,error}});
 return async function handleAgent(method:string,path:string,input:unknown,bytes=0):Promise<{status:number;body:any}>{
  const action=path.slice('/api/agent/'.length);
  if(!['state','import','run','resume'].includes(action))return fail(404,'Not found');
  if(method!==(action==='state'?'GET':'POST'))return fail(405,'Method not allowed');
  if(bytes>AGENT_BODY_LIMIT)return fail(413,'Request too large.');
  let body:Record<string,unknown>={};
  if(action!=='state'){
   if(!input||typeof input!=='object'||Array.isArray(input))return fail(400,'Invalid request.');
   body=input as Record<string,unknown>;
   const fields=Object.keys(body).sort().join(',');
   if(action==='import'){
    if(fields!=='invoice'||!body.invoice||typeof body.invoice!=='object'||Array.isArray(body.invoice))return fail(400,'Invalid signed invoice.');
   }else{
    if(fields!==(action==='run'?'id,live':'id')||typeof body.id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(body.id))return fail(400,'Invalid invoice reference.');
    if(action==='run'&&typeof body.live!=='boolean')return fail(400,'Invalid live model choice.');
   }
  }
  const payment=action==='run'||action==='resume';
  if(payment&&running)return fail(409,'An agent payment is already in progress.');
  if(action==='run'&&body.live&&!deps.modelReady())return fail(400,'No model key configured');
  if(payment)running=true;
  try{
   const result=action==='state'?await deps.state():action==='import'?await deps.importBill(body.invoice):
    action==='run'?await deps.run(body.id as string,body.live as boolean):await deps.resume(body.id as string);
   return {status:200,body:{ok:true,...(action==='state'?{state:result}:result as object)}};
  }catch(error){
   const message=deps.error(error);
   return fail(message==='Agent vault is in use by another process'?409:
    message==='No agent vault yet. Run npm run agent:desk -- init first.'?200:400,message);
  }finally{if(payment)running=false;}
 };
}
