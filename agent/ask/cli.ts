// `agent:desk ask --facts`: print the read-only facts pack as one JSON object.
import {collectFacts} from './facts.ts';
import {AskError} from './views.ts';

export async function askCommand(args:string[],directory:string):Promise<string>{
 if(args.length!==1||args[0]!=='--facts')throw new AskError('Usage: agent:desk ask --facts');
 return JSON.stringify(await collectFacts(directory),null,2);
}
export {AskError};
