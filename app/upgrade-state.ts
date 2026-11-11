import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';

export type StorageEntry={key:string,value:string};
export function checkWeeklyUpgradeMethods(methods:ReadonlySet<string>,journalStorage?:StorageEntry[]){
 // A pinned journal predating either feature can still finish its original
 // deployment. Once records exist, the deployed code must understand them.
 const hasRecords=(prefix:string)=>!journalStorage || journalStorage.some(entry=>Buffer.from(entry.key,'base64').toString('utf8').startsWith(prefix));
 if(!hasRecords('weekly-'))return;
 const required=['add_weekly_service','revoke_weekly_service','get_weekly_service','current_service_period','get_service_claim','authorize_signed_invoice','get_invoice_auth'];
 if(hasRecords('weekly-corrections-v1'))required.push('correct_weekly_invoice','get_weekly_correction');
 const missing=required.find(name=>!methods.has(name));
 if(!missing)return;
 throw Error('Build the current contract before upgrading. Missing weekly billing method '+missing+'.');
}
export const digest=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
const json=(value:unknown)=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?{integer:v.toString()}:v);
export function storageDigest(entries:StorageEntry[]){
 const keys=new Set<string>();
 for(const e of entries){
  if(typeof e.key!=='string'||typeof e.value!=='string'||keys.has(e.key))throw Error('Invalid or duplicate vault storage entry');
  for(const v of [e.key,e.value])if(Buffer.from(v,'base64').toString('base64')!==v)throw Error('Invalid vault storage encoding');
  keys.add(e.key);
 }
 return digest(json([...entries].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)));
}
// NEAR legacy LookupMap uses the prefix followed by the Borsh string key.
// Inspect every payment, including invoices missing from the local UI/inbox.
export function storedInvoiceIds(entries:StorageEntry[]){
 return entries.flatMap(({key})=>{
  const b=Buffer.from(key,'base64');if(b.length<6||b[0]!==112)return [];
  const length=b.readUInt32LE(1);if(length<1||length>128||b.length!==length+5)return [];
  const id=b.subarray(5).toString('utf8');if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(id))throw Error('Invalid stored invoice ID');return [id];
 }).sort();
}
export function rootAccounts(entries:StorageEntry[]){
 const value=entries.find(e=>Buffer.from(e.key,'base64').toString()==='STATE')?.value;
 if(!value)throw Error('Vault is not initialized');
 const b=Buffer.from(value,'base64');let offset=0;
 const account=()=>{if(offset+4>b.length)throw Error('Unsupported vault state');const n=b.readUInt32LE(offset);offset+=4;
  if(n<2||n>64||offset+n>b.length)throw Error('Unsupported vault state');const v=b.subarray(offset,offset+n).toString('utf8');offset+=n;
  if(!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v))throw Error('Unsupported vault account');return v;};
 const accounts={owner:account(),executor:account()};
 if(offset+21!==b.length||b.readUInt32LE(offset)!==1||b[offset+4]!==112)throw Error('Unsupported vault payment storage layout');
 return accounts;
}
export function localRecords(directory:string){
 const files:Record<string,string>={'desk.json':digest(readFileSync(join(directory,'desk.json')))};
 const renewals=join(directory,'policy-renewals');
 if(existsSync(renewals))for(const name of readdirSync(renewals).filter(n=>n.endsWith('.json')).sort())files['policy-renewals/'+name]=digest(readFileSync(join(renewals,name)));
 const databases:Record<string,{digest:string;invoices:number;attempts:number}>={};
 for(const name of readdirSync(directory).filter(n=>n.endsWith('.db')).sort()){
  const db=new DatabaseSync(join(directory,name),{readOnly:true});
  try{
   if(db.prepare('PRAGMA integrity_check').all().some(r=>Object.values(r)[0]!=='ok'))throw Error('Local database integrity check failed');
   const tables=db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
   const data=tables.map(t=>{const statement=db.prepare('SELECT * FROM "'+String(t.name).replaceAll('"','""')+'"');statement.setReadBigInts(true);
    const rows=statement.all();if(t.name==='inbox'&&rows.some(r=>r.state==='inference_pending'))throw Error('Finish or explicitly retry interrupted inference before upgrading');
    return {name:t.name,sql:t.sql,rows:rows.map(json).sort()};});
   databases[name]={digest:digest(json(data)),invoices:data.find(t=>t.name==='inbox')?.rows.length??0,attempts:data.find(t=>t.name==='attempts')?.rows.length??0};
  }finally{db.close();}
 }
 return {files,databases};
}
export function requireUpgradeVerified(directory:string){
 if(existsSync(join(directory,'upgrade-pending.json')))throw Error('Local vault upgrade needs verification. Run sandbox:upgrade for this vault before using it.');
}
