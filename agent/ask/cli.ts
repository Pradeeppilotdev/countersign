// agent:desk ask --facts | ask --check <invoice.json> | ask --account <account_id> | ask "<question>"
// All four only read. A question makes one model call with no tools; --account makes none.
import {readFileSync,statSync} from 'node:fs';
import {askQuestion} from './answer.ts';
import {checkAccount,networkFrom,renderAccount,type AccountCheck} from './account.ts';
import {checkInvoice,invoiceVerdict} from './check.ts';
import {collectFacts,openSources} from './facts.ts';
import {modelConfig,nearChat} from './model.ts';
import {AskError} from './views.ts';

const USAGE='Usage: agent:desk ask --facts | ask --check <signed-invoice.json> | ask --account <account_id> | ask "<question>"';
export async function askCommand(args:string[],directory:string):Promise<string>{
 const [first,second]=args;
 if(first==='--facts'&&args.length===1)return JSON.stringify(await collectFacts(directory),null,2);
 if(first==='--check'&&args.length===2){
  let raw:unknown;
  try{if(statSync(second).size>16384)throw Error('too large');raw=JSON.parse(readFileSync(second,'utf8'));}
  catch{throw new AskError('Ask Dave: that invoice file could not be read.');}
  const {reader,pack}=await openSources(directory); // same vault/inbox identity check as --facts
  const result=await checkInvoice(raw,{vault:reader.vault,view:reader.view,pack});
  // Would you pay this account? The same code verdict as ask --account, for the invoice's payee.
  const payee=result.invoice?.payee;
  let payee_account:AccountCheck|{verdict:null;unavailable:string}|undefined;
  if(payee){
   try{
    // openSources reads a local vault. The network preference is only for standalone --account.
    payee_account=await checkAccount(payee,{network:'local',directory,pack});
    result.checks.push({check:'payee_account',result:payee_account.verdict==='STOP'?'bad':payee_account.verdict==='WARN'?'caution':'good',
     reason:payee_account.verdict==='PAY'?'A pinned supplier payout account with paid history.':payee_account.reasons.join(' ')});
   }catch(error){
    if(!(error instanceof AskError))throw error;
    payee_account={verdict:null,unavailable:error.message};
    result.checks.push({check:'payee_account',result:'cannot verify',reason:error.message});
   }
   result.verdict=invoiceVerdict(result.checks);
  }
  return JSON.stringify({...result,payee_account},null,2);
 }
 if(first==='--account'&&args.length===2){
  const network=networkFrom(process.env.COUNTERSIGN_NETWORK);
  // The local vault is read only for a local account; it says nothing about testnet or mainnet.
  const pack=network==='local'?await collectFacts(directory):null;
  return renderAccount(await checkAccount(second,{network,directory,pack}));
 }
 if(args.length!==1||!first.trim()||first.startsWith('-'))throw new AskError(USAGE);
 if(first.length>500)throw new AskError('Ask Dave: keep the question under 500 characters.');
 const complete=nearChat(modelConfig()); // fails here, before any read, when no key is set
 const verdict=await askQuestion(await collectFacts(directory),first,complete);
 // Developer aid only: say why an answer was discarded. The owner still sees the fixed line.
 if(!verdict.ok&&process.env.COUNTERSIGN_ASK_DEBUG)console.error(`[ask debug] ${verdict.why}`);
 return verdict.text;
}
export {AskError};
