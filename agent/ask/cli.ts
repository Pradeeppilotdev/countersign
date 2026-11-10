// agent:desk ask --facts | ask --check <invoice.json> | ask "<question>"
// All three only read. A question makes one model call with no tools.
import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {askQuestion} from './answer.ts';
import {checkInvoice} from './check.ts';
import {buildFacts,collectFacts} from './facts.ts';
import {readInbox} from './inbox-reader.ts';
import {modelConfig,nearChat} from './model.ts';
import {AskError,openVaultReader} from './views.ts';

const USAGE='Usage: agent:desk ask --facts | ask --check <signed-invoice.json> | ask "<question>"';
export async function askCommand(args:string[],directory:string):Promise<string>{
 const [first,second]=args;
 if(first==='--facts'&&args.length===1)return JSON.stringify(await collectFacts(directory),null,2);
 if(first==='--check'&&args.length===2){
  let raw:unknown;
  try{if(statSync(second).size>16384)throw Error('too large');raw=JSON.parse(readFileSync(second,'utf8'));}
  catch{throw new AskError('Ask Dave: that invoice file could not be read.');}
  const reader=await openVaultReader(directory);
  const pack=await buildFacts({vault:reader.vault,block_height:reader.block_height,view:reader.view,inbox:readInbox(join(directory,'inbox.db'))});
  return JSON.stringify(await checkInvoice(raw,{vault:reader.vault,view:reader.view,pack}),null,2);
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
