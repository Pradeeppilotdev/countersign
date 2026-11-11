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
fn payload_hash(signed:&SignedInvoice)->String {
 env::sha256(&bytes(signed)).iter().map(|b|format!("{:02x}",b)).collect()
}
fn authenticate(signed:&SignedInvoice,require_fresh:bool)->String {
 near_sdk::require!(valid_id(&signed.merchant_id)&&valid_id(&signed.bill_id),"invalid merchant bill id");
 near_sdk::require!(signed.vault==env::current_account_id(),"signed vault mismatch");
 near_sdk::require!(domains().get(&0).as_ref()==Some(&signed.domain),"signed domain mismatch");
 let key=keys().get(&signed.merchant_id).unwrap_or_else(||env::panic_str("unknown merchant key"));
 let public=key.public_key.unwrap_or_else(||env::panic_str("merchant key revoked"));
 near_sdk::require!(signed.key_version.0==key.version.0,"merchant key version mismatch");
 if require_fresh {
  let now=env::block_timestamp_ms();near_sdk::require!(signed.expires_at.0>now&&signed.expires_at.0<=now.saturating_add(86_400_000),"signed invoice expired or excessive lifetime");
 }
 let signature:&[u8;64]=signed.signature.0.as_slice().try_into().unwrap_or_else(|_|env::panic_str("invalid merchant signature"));
 let public:&[u8;32]=public.0.as_slice().try_into().unwrap_or_else(|_|env::panic_str("invalid merchant key"));
 let payload=bytes(signed);near_sdk::require!(env::ed25519_verify(signature,&payload,public),"invalid merchant signature");
 env::sha256(&payload).iter().map(|b|format!("{:02x}",b)).collect()
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
 // Owner rejection can precede authorization or a late model response. Keep
 // the signed identity permanently used without reserving funds or the week.
 pub fn cancel_signed_invoice(&mut self,signed:SignedInvoice)->Payment {
  near_sdk::require!(env::predecessor_account_id()==self.owner,"owner only");
  let id=signed.invoice.id.clone();
  if let Some(payment)=self.payments.get(&id) {
   near_sdk::require!(payment.commitment==commitment(&signed.invoice),"invoice mismatch");
   let receipt=receipts().get(&id).unwrap_or_else(||env::panic_str("signed invoice already bound"));
   near_sdk::require!(receipt.payload_hash==payload_hash(&signed),"signed invoice already bound");
   return self.cancel(id); // Existing reservation and in-flight guards still apply.
  }
  near_sdk::require!(valid_id(&id)&&signed.invoice.amount.0>0&&signed.invoice.asset=="near","invalid invoice");
  near_sdk::require!(signed.service.as_ref().is_none_or(|s|valid_id(&s.agreement_id)),"invalid service agreement id");
  near_sdk::require!(routes().get(&id).is_none()&&receipts().get(&id).is_none(),"invoice id already used");
  // Cancellation creates no spending authority. A genuine expired bill may
  // be rejected; an unrecorded bill still needs the currently pinned key.
  let hash=authenticate(&signed,false);
  let bill=(signed.merchant_id.clone(),signed.bill_id.clone());
  near_sdk::require!(bills().get(&bill).is_none(),"merchant bill already used");
  let payment=Payment{commitment:commitment(&signed.invoice),invoice:signed.invoice.clone(),state:State::Cancelled,attempt_id:None};
  self.payments.insert(&id,&payment);
  expiries().insert(&id,&signed.expires_at.0);
  bills().insert(&bill,&id);
  receipts().insert(&id,&InvoiceAuth{merchant_id:signed.merchant_id,key_version:signed.key_version,payload_hash:hash});
  payment
 }
}

#[cfg(test)]
mod tests {
 use super::*;
 use near_sdk::{test_utils::VMContextBuilder,testing_env,serde_json::{from_value,json}};
 fn context(actor:&str,ms:u64) {
  testing_env!(VMContextBuilder::new().current_account_id("vault.near".parse().unwrap())
   .predecessor_account_id(actor.parse().unwrap()).block_timestamp(ms*1_000_000).build());
 }
 fn fixture()->(Contract,SignedInvoice) {
  context("owner.near",1000);
  let mut c=Contract::new("owner.near".parse().unwrap(),"executor.near".parse().unwrap());c.available=1000;
  c.configure_invoice_auth("a".repeat(64));
  c.set_merchant_key("supplier".into(),Some(from_value(json!("B74XhyDVcoo0KFjTyU+tmZwkHNJHjzm9NMNT7+wy9nk=")).unwrap()));
  // Same public interoperability vector used by the weekly service tests.
  let signed=from_value(json!({
   "invoice":{"id":"claimed-week","payee":"merchant.near","asset":"near","amount":"40"},
   "merchant_id":"supplier","bill_id":"bill","vault":"vault.near","domain":"a".repeat(64),
   "key_version":"1","expires_at":"3600000","service":{"agreement_id":"compute","period_start_ms":"0"},
   "signature":"/X8VxqSv2PPnRLpAf5OuFpnREKBwAX+FqSP0NVzJV5bvNXbnTQwMFpKKEBns4dDTKFiN2yEqVw/wVrHTnePtCg=="
  })).unwrap();
  (c,signed)
 }
 fn authorize(c:&mut Contract,signed:&SignedInvoice) {
  c.set_policy(vec![policy::Merchant{id:"supplier".into(),payee:"merchant.near".parse().unwrap()}],U128(100),U128(150),U64(10_000_000),None);
  c.add_weekly_service("compute".into(),"supplier".into(),U64(0),U128(100));
  context("executor.near",1000);c.authorize_signed_invoice(signed.clone());
 }
 #[test] fn queued_signed_cancellation_needs_no_policy_and_keeps_budget_and_week_unused() {
  let (mut c,s)=fixture();c.set_paused(true);
  let p=c.cancel_signed_invoice(s.clone());
  assert_eq!(p.state,State::Cancelled);assert!(p.attempt_id.is_none());
  assert_eq!(c.available,1000);assert_eq!(c.policy_usage().0,0);
  assert_eq!(c.get_service_claim(s.service.clone().unwrap()),None);
  assert_eq!(c.get_merchant_bill_invoice(s.merchant_id.clone(),s.bill_id.clone()),Some(s.invoice.id.clone()));
  let receipt=c.get_invoice_auth(s.invoice.id.clone()).unwrap();assert_eq!(receipt.payload_hash,payload_hash(&s));
  c.set_merchant_key(s.merchant_id.clone(),None);
  context("owner.near",4_000_000);assert_eq!(c.cancel_signed_invoice(s.clone()).state,State::Cancelled);
  assert_eq!(c.available,1000);assert_eq!(c.policy_usage().0,0);
  assert_eq!(c.get_invoice_auth(s.invoice.id).unwrap().payload_hash,receipt.payload_hash);
 }
 #[test] fn expired_unrecorded_signed_bill_can_be_rejected_without_reviving_it() {
  let (mut c,s)=fixture();context("owner.near",4_000_000);
  assert_eq!(c.cancel_signed_invoice(s).state,State::Cancelled);assert_eq!(c.available,1000);
 }
 #[test] fn authorization_winning_the_race_releases_its_charge_once_using_the_retained_receipt() {
  let (mut c,s)=fixture();authorize(&mut c,&s);assert_eq!(c.policy_usage().0,40);
  context("owner.near",1001);c.set_merchant_key(s.merchant_id.clone(),None);
  for _ in 0..2 {assert_eq!(c.cancel_signed_invoice(s.clone()).state,State::Cancelled);}
  assert_eq!(c.policy_usage().0,0);assert_eq!(c.available,1000);
  assert_eq!(c.get_service_claim(s.service.unwrap()),Some(s.invoice.id));
 }
 #[test] #[should_panic(expected="owner only")] fn executor_cannot_cancel_a_queued_bill() {
  let (mut c,s)=fixture();context("executor.near",1000);c.cancel_signed_invoice(s);
 }
 #[test] #[should_panic(expected="invalid merchant signature")] fn forged_queued_bill_cannot_create_a_cancellation_record() {
  let (mut c,mut s)=fixture();s.invoice.amount=U128(39);c.cancel_signed_invoice(s);
 }
 #[test] #[should_panic(expected="signed invoice already bound")] fn another_signed_payload_cannot_cancel_the_same_transfer_terms() {
  let (mut c,mut s)=fixture();authorize(&mut c,&s);context("owner.near",1001);
  s.bill_id="different-bill".into();c.cancel_signed_invoice(s);
 }
 #[test] #[should_panic(expected="reservation has not expired")] fn queued_cancellation_losing_to_reservation_keeps_the_hold() {
  let (mut c,s)=fixture();authorize(&mut c,&s);c.reserve(s.invoice.clone(),"same-attempt".into());
  context("owner.near",1001);c.cancel_signed_invoice(s);
 }
 #[test] #[should_panic(expected="only authorized or expired reserved invoices can be cancelled")] fn in_flight_signed_payment_cannot_be_cancelled() {
  let (mut c,s)=fixture();authorize(&mut c,&s);let mut p=c.reserve(s.invoice.clone(),"same-attempt".into());
  p.state=State::Executing;c.payments.insert(&s.invoice.id,&p);
  context("owner.near",1001);c.cancel_signed_invoice(s);
 }
 #[test] #[should_panic(expected="invoice cancelled")] fn a_queued_cancellation_cannot_be_authorized_later() {
  let (mut c,s)=fixture();c.cancel_signed_invoice(s.clone());context("executor.near",1001);c.authorize_signed_invoice(s);
 }
}

// Shared with owner-approved weekly corrections. Callers enforce their own role.
impl Contract {
 pub(super) fn apply_signed_invoice(&mut self,signed:SignedInvoice)->Payment {
  controls::require_running();
  let hash=authenticate(&signed,true);
  let bill=(signed.merchant_id.clone(),signed.bill_id.clone());
  if let Some(id)=bills().get(&bill){near_sdk::require!(id==signed.invoice.id,"merchant bill already used");}
  if let Some(old)=receipts().get(&signed.invoice.id){near_sdk::require!(old.payload_hash==hash,"signed invoice already bound");}
  else{near_sdk::require!(self.payments.get(&signed.invoice.id).is_none(),"invoice already authorized without signature");}
  near_sdk::require!(self.payments.get(&signed.invoice.id).is_none_or(|p|p.state!=State::Cancelled),"invoice cancelled");
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
