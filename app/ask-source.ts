// Public identities only. Never return the saved directory, keys or inbox data.
import {readFileSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {validAccount} from '../agent/ask/views.ts';

function account(directory:string):string|null{
 try{
  const path=join(directory,'desk.json');
  if(statSync(path).size>4*1024*1024)return null;
  const value=JSON.parse(readFileSync(path,'utf8')).vault;
  return validAccount(value)?value:null;
 }catch{return null;}
}
export function askSource(agentDirectory:string,paymentDirectory:string,network:string|undefined){
 const accountNetwork=network===undefined||network===''||network==='sandbox'||network==='local'?'local':
  network==='testnet'||network==='mainnet'?network:null;
 return {
  agentVault:account(agentDirectory),paymentVault:account(paymentDirectory),
  separate:resolve(agentDirectory)!==resolve(paymentDirectory),
  questionNetwork:'local',accountNetwork,
 };
}
