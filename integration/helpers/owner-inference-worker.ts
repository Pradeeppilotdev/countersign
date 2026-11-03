// Test-only IPC-gated proposer; production CLI has no delay/fault switches.
import {runPersistentInvoice} from '../../agent/run-invoice.ts';
const [directory,id]=process.argv.slice(2);
try{
 const result=await runPersistentInvoice(directory,id,async invoice=>{
  process.send?.('inference');
  await new Promise<void>(resolve=>process.once('message',()=>resolve()));
  return {name:'request_payment',arguments:{invoice_id:invoice.id}};
 });
 process.send?.({state:result.state});
}catch(error){process.send?.({error:error instanceof Error?error.message:String(error)});}
finally{process.disconnect?.();}
