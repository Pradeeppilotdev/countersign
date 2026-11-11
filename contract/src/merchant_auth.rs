use super::*;
use near_sdk::json_types::Base64VecU8;
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct MerchantKey { pub version:U64, pub public_key:Option<Base64VecU8> }
#[near(serializers=[borsh,json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct SignedInvoice {
 pub invoice:Invoice, pub merchant_id:String, pub bill_id:String, pub vault:AccountId,
 #[serde(default, skip_serializing_if = "Option::is_none")]
 pub service: Option<service::ServicePeriod>,
 pub domain:String, pub key_version:U64, pub expires_at:U64, pub signature:Base64VecU8,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct InvoiceAuth { pub merchant_id:String, pub key_version:U64, pub payload_hash:String }
fn domains()->LookupMap<u8,String>{LookupMap::new(b"invoice-domain-v1".to_vec())}
fn keys()->LookupMap<String,MerchantKey>{LookupMap::new(b"merchant-keys-v1".to_vec())}
fn receipts()->LookupMap<String,InvoiceAuth>{LookupMap::new(b"invoice-auth-v1".to_vec())}
fn bills()->LookupMap<(String,String),String>{LookupMap::new(b"merchant-bills-v1".to_vec())}
fn bytes(s:&SignedInvoice)->Vec<u8>{
 let mut fields = vec![s.domain.clone(), s.vault.to_string(), s.merchant_id.clone(), s.bill_id.clone(),
     s.key_version.0.to_string(), s.expires_at.0.to_string(), s.invoice.id.clone(),
     s.invoice.payee.to_string(), s.invoice.asset.clone(), s.invoice.amount.0.to_string()];
 let mut out = if let Some(period) = &s.service {
     fields.push(period.agreement_id.clone());
     fields.push(period.period_start_ms.0.to_string());
     b"COUNTERSIGN-SIGNED-INVOICE-V2\n".to_vec()
 } else {
     b"COUNTERSIGN-SIGNED-INVOICE-V1\n".to_vec()
 };
 for field in fields {
     out.extend_from_slice(format!("{}:", field.len()).as_bytes());
     out.extend_from_slice(field.as_bytes());
 }
 out
}
pub(super) fn signed_envelope_hash(signed: &SignedInvoice) -> [u8; 32] {
 let mut payload = bytes(signed);
 payload.extend_from_slice(&signed.signature.0);
 env::sha256_array(&payload)
}
pub(super) fn require_unsigned(merchant:&String){near_sdk::require!(keys().get(merchant).is_none(),"merchant signature required");}
pub(super) fn check_bound(invoice:&Invoice,merchant:&String){
 if let Some(key)=keys().get(merchant){
  near_sdk::require!(key.public_key.is_some(),"merchant key revoked");
  let receipt=receipts().get(&invoice.id).unwrap_or_else(||env::panic_str("merchant signature required"));
  near_sdk::require!(receipt.merchant_id==*merchant&&receipt.key_version.0==key.version.0,"merchant key changed; approval invalidated");
 }
}
#[near]
impl Contract {
 pub fn configure_invoice_auth(&mut self,domain:String)->String{
  near_sdk::require!(env::predecessor_account_id()==self.owner,"owner only");
  near_sdk::require!(domain.len()==64&&domain.bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c)),"invalid signing domain");
  if let Some(old)=domains().get(&0){near_sdk::require!(old==domain,"signing domain already bound");return old;}
  domains().insert(&0,&domain);domain
 }
 pub fn get_invoice_domain(&self)->Option<String>{domains().get(&0)}
 pub fn set_merchant_key(&mut self,merchant_id:String,public_key:Option<Base64VecU8>)->MerchantKey{
  near_sdk::require!(env::predecessor_account_id()==self.owner,"owner only");
  near_sdk::require!(domains().get(&0).is_some(),"configure signing domain first");
  near_sdk::require!(valid_id(&merchant_id),"invalid merchant id");
  // Retained key records cannot be deleted: revocation never restores unsigned authority.
  if let Some(ref key)=public_key {near_sdk::require!(key.0.len()==32,"invalid merchant key");}
  let version=keys().get(&merchant_id).map_or(0,|k|k.version.0).checked_add(1).unwrap_or_else(||env::panic_str("merchant key version overflow"));
  let key=MerchantKey{version:U64(version),public_key};keys().insert(&merchant_id,&key);key
 }
 pub fn get_merchant_key(&self,merchant_id:String)->Option<MerchantKey>{keys().get(&merchant_id)}
 pub fn get_merchant_bill_invoice(&self,merchant_id:String,bill_id:String)->Option<String>{bills().get(&(merchant_id,bill_id))}
 pub fn get_invoice_auth(&self,invoice_id:String)->Option<InvoiceAuth>{receipts().get(&invoice_id)}
 pub fn authorize_signed_invoice(&mut self,signed:SignedInvoice)->Payment{
  near_sdk::require!(env::predecessor_account_id()==self.executor,"executor only");
  self.apply_signed_invoice(signed)
 }
}

// Shared with owner-approved weekly corrections. Callers enforce their own role.
impl Contract {
 pub(super) fn apply_signed_invoice(&mut self,signed:SignedInvoice)->Payment {
  controls::require_running();
  near_sdk::require!(valid_id(&signed.merchant_id)&&valid_id(&signed.bill_id),"invalid merchant bill id");
  near_sdk::require!(signed.vault==env::current_account_id(),"signed vault mismatch");
  near_sdk::require!(domains().get(&0).as_ref()==Some(&signed.domain),"signed domain mismatch");
  let key=keys().get(&signed.merchant_id).unwrap_or_else(||env::panic_str("unknown merchant key"));
  let public=key.public_key.unwrap_or_else(||env::panic_str("merchant key revoked"));
  near_sdk::require!(signed.key_version.0==key.version.0,"merchant key version mismatch");
  let now=env::block_timestamp_ms();near_sdk::require!(signed.expires_at.0>now&&signed.expires_at.0<=now.saturating_add(86_400_000),"signed invoice expired or excessive lifetime");
  let signature:&[u8;64]=signed.signature.0.as_slice().try_into().unwrap_or_else(|_|env::panic_str("invalid merchant signature"));
  let public:&[u8;32]=public.0.as_slice().try_into().unwrap_or_else(|_|env::panic_str("invalid merchant key"));
  let payload=bytes(&signed);near_sdk::require!(env::ed25519_verify(signature,&payload,public),"invalid merchant signature");
  let hash:String=env::sha256(&payload).iter().map(|b|format!("{:02x}",b)).collect();
  let bill=(signed.merchant_id.clone(),signed.bill_id.clone());
  if let Some(id)=bills().get(&bill){near_sdk::require!(id==signed.invoice.id,"merchant bill already used");}
  if let Some(old)=receipts().get(&signed.invoice.id){near_sdk::require!(old.payload_hash==hash,"signed invoice already bound");}
  else{near_sdk::require!(self.payments.get(&signed.invoice.id).is_none(),"invoice already authorized without signature");}
  let expiry = service::authorization_expiry(&signed);
  let p=self.authorize_policy_invoice(signed.invoice.clone(),signed.merchant_id.clone(),Some(signed.expires_at));
  if let Some(period) = &signed.service {
      expiries().insert(&signed.invoice.id, &expiry.0);
      service::record(&signed.invoice.id, period);
  }
  bills().insert(&bill,&signed.invoice.id);
  receipts().insert(&signed.invoice.id,&InvoiceAuth{merchant_id:signed.merchant_id,key_version:signed.key_version,payload_hash:hash});p
 }
}
