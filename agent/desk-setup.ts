// Shared owner operations for the CLI and local café. The vault enforces all rules.
import {randomBytes} from 'node:crypto';
import {parseNear, type SandboxDesk} from '../app/sandbox.ts';
import {validMillis} from '../merchant/invoice.ts';
import {readDeskCapacity} from './desk-core.ts';
export async function setDeskMerchantKey(desk:SandboxDesk,merchant_id:string,public_key:string|null){
 if(public_key!==null){
  const key=Buffer.from(public_key,'base64');
  if(key.length!==32||key.toString('base64')!==public_key)throw Error('Expected a canonical base64 Ed25519 public key');
  if(!await desk.vault.view('get_invoice_domain',{}))await desk.owner.call(desk.vault,'configure_invoice_auth',{domain:randomBytes(32).toString('hex')});
 }
 const result=await desk.owner.call(desk.vault,'set_merchant_key',{merchant_id,public_key});
 return {...result,vault:desk.vault.accountId,domain:await desk.vault.view('get_invoice_domain',{})};
}
export async function setDeskPolicy(desk:SandboxDesk,perPayment:string,dailyLimit:string,minutes:number,minimum?:string,merchants=[{id:'local-merchant',payee:desk.merchant.accountId}]){
 const per=parseNear(perPayment),daily=parseNear(dailyLimit);
 if(!Number.isInteger(minutes)||minutes<1||minutes>1440||BigInt(daily)<BigInt(per))throw Error('Policy needs a positive cap, rolling allowance >= cap, and expiry from 1 to 1440 minutes');
 await readDeskCapacity(desk.vault);
 return desk.owner.call(desk.vault,'set_policy',{merchants,per_payment:per,daily_limit:daily,expires_at:String(Date.now()+minutes*60000),min_payment:minimum===undefined?null:parseNear(minimum)});
}
export async function addDeskWeeklyService(desk:SandboxDesk,agreement_id:string,merchant_id:string,amount:string,anchor_ms:string){
 if(!validMillis(anchor_ms))throw Error('Enter a UTC timestamp in integer milliseconds.');
 return desk.owner.call(desk.vault,'add_weekly_service',{agreement_id,merchant_id,cap:parseNear(amount),anchor_ms});
}
