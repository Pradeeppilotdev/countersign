// Read-only copy of the agent inbox for Ask Dave. The database is opened with
// readOnly:true, so this file cannot enqueue, propose, resume or cancel anything.
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';

export type InboxRow={
 id:string;merchant:string;state:string;error:string|null;generation:number;has_proposal:boolean;
 invoice:{id:string;payee:string;asset:string;amount:string};
 signed:null|{bill_id:string;key_version:string;expires_at:string;service:null|{agreement_id:string;period_start_ms:string}};
 attempt_state:string|null;
};
export type InboxCopy={present:boolean;scope:string|null;rows:InboxRow[]};

export function readInbox(path:string):InboxCopy{
 if(!existsSync(path))return {present:false,scope:null,rows:[]};
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  const tables=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t=>String(t.name)));
  if(!tables.has('inbox'))return {present:false,scope:null,rows:[]};
  const scope=tables.has('inbox_scope')?db.prepare('SELECT vault FROM inbox_scope WHERE id=1').get()?.vault:null;
  const attempts=new Map<string,string>();
  if(tables.has('attempts'))for(const a of db.prepare('SELECT invoice_id,state FROM attempts').all())attempts.set(String(a.invoice_id),String(a.state));
  const rows=db.prepare('SELECT * FROM inbox ORDER BY rowid').all().map(row=>{
   const invoice=JSON.parse(String(row.invoice));
   const s=row.signed_invoice?JSON.parse(String(row.signed_invoice)):null;
   // Signatures and signing domains are deliberately left out of the facts.
   const signed=s?{bill_id:String(s.bill_id),key_version:String(s.key_version),expires_at:String(s.expires_at),
    service:s.service?{agreement_id:String(s.service.agreement_id),period_start_ms:String(s.service.period_start_ms)}:null}:null;
   return {id:String(row.id),merchant:String(row.merchant),state:String(row.state),error:row.error===null?null:String(row.error),
    generation:Number(row.generation),has_proposal:row.proposal!==null,
    invoice:{id:String(invoice.id),payee:String(invoice.payee),asset:String(invoice.asset),amount:String(invoice.amount)},
    signed,attempt_state:attempts.get(String(row.id))??null};
  });
  return {present:true,scope:scope===null||scope===undefined?null:String(scope),rows};
 }finally{db.close();}
}
