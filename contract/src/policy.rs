use super::*;
const WINDOW: u64=86_400_000;
const MAX_CHARGES: usize=128;
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Merchant { pub id:String, pub payee:AccountId }
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct SpendingPolicy { pub version:U64, pub merchants:Vec<Merchant>, pub per_payment:U128, pub daily_limit:U128, pub expires_at:U64 }
#[near(serializers=[borsh])]
#[derive(Clone)]
struct Binding { version:u64, merchant:String }
#[near(serializers=[borsh])]
#[derive(Clone)]
struct Charge { invoice_id:String, amount:u128, dispatched_at:Option<u64> }
fn policies()->LookupMap<u8,SpendingPolicy>{LookupMap::new(b"policy-config-v1".to_vec())}
fn versions()->LookupMap<u8,u64>{LookupMap::new(b"policy-version-v1".to_vec())}
fn bindings()->LookupMap<String,Binding>{LookupMap::new(b"invoice-policy-v1".to_vec())}
fn ledger()->LookupMap<u8,Vec<Charge>>{LookupMap::new(b"policy-charges-v1".to_vec())}
fn active(c:&Contract)->Vec<Charge>{
 let now=env::block_timestamp_ms();
 ledger().get(&0).unwrap_or_default().into_iter().filter(|e|{
  // Pending approvals/holds and uncertain Executing payments NEVER age out.
  e.dispatched_at.is_none() || c.payments.get(&e.invoice_id).is_some_and(|p|p.state==State::Executing)
    || e.dispatched_at.is_some_and(|t|now.saturating_sub(t)<WINDOW)
 }).collect()
}
fn total(charges:&[Charge])->u128{charges.iter().fold(0u128,|n,e|n.checked_add(e.amount).unwrap_or_else(||env::panic_str("policy accounting overflow")))}
fn check(policy:&SpendingPolicy,invoice:&Invoice,merchant:&str){
 near_sdk::require!(env::block_timestamp_ms()<policy.expires_at.0,"policy expired");
 let entry=policy.merchants.iter().find(|m|m.id==merchant).unwrap_or_else(||env::panic_str("merchant not allowed"));
 near_sdk::require!(entry.payee==invoice.payee,"merchant payout mismatch");
 near_sdk::require!(invoice.asset=="near" && invoice.amount.0>0,"only positive native NEAR supported");
 near_sdk::require!(invoice.amount.0<=policy.per_payment.0,"per-payment cap exceeded");
}
pub(super) fn check_bound(invoice:&Invoice){
 if let Some(binding)=bindings().get(&invoice.id){
  let policy=policies().get(&0).unwrap_or_else(||env::panic_str("policy revoked"));
  near_sdk::require!(policy.version.0==binding.version,"policy changed; approval invalidated");
  check(&policy,invoice,&binding.merchant);
  merchant_auth::check_bound(invoice,&binding.merchant);
 }
}
pub(super) fn record_execution(invoice:&Invoice){
 if bindings().get(&invoice.id).is_some(){
  let mut charges=ledger().get(&0).unwrap_or_default();
  let e=charges.iter_mut().find(|e|e.invoice_id==invoice.id).unwrap_or_else(||env::panic_str("missing policy hold"));
  near_sdk::require!(e.dispatched_at.is_none(),"policy already dispatched");
  e.dispatched_at=Some(env::block_timestamp_ms());ledger().insert(&0,&charges);
 }
}
pub(super) fn release_charge(id:&String){
 if bindings().get(id).is_some(){let mut charges=ledger().get(&0).unwrap_or_default();charges.retain(|e|e.invoice_id!=*id);ledger().insert(&0,&charges);}
}
#[near]
impl Contract {
 pub fn set_policy(&mut self,merchants:Vec<Merchant>,per_payment:U128,daily_limit:U128,expires_at:U64)->SpendingPolicy {
  near_sdk::require!(env::predecessor_account_id()==self.owner,"owner only");
  near_sdk::require!(!merchants.is_empty()&&merchants.len()<=32,"one to 32 merchants required");
  for (i,m) in merchants.iter().enumerate(){near_sdk::require!(valid_id(&m.id)&&!merchants[..i].iter().any(|x|x.id==m.id),"invalid or duplicate merchant id");}
  near_sdk::require!(per_payment.0>0 && daily_limit.0>=per_payment.0,"invalid policy limits");
  let now=env::block_timestamp_ms();near_sdk::require!(expires_at.0>now&&expires_at.0<=now.saturating_add(30*WINDOW),"policy expiry must be within 30 days");
  let version=versions().get(&0).unwrap_or(0).checked_add(1).unwrap_or_else(||env::panic_str("policy version overflow"));
  let p=SpendingPolicy{version:U64(version),merchants,per_payment,daily_limit,expires_at};
  versions().insert(&0,&version);policies().insert(&0,&p);p
 }
 pub fn revoke_policy(&mut self){near_sdk::require!(env::predecessor_account_id()==self.owner,"owner only");policies().remove(&0);}
 pub fn get_policy(&self)->Option<SpendingPolicy>{policies().get(&0)}
 pub fn policy_usage(&self)->U128{U128(total(&active(self)))}
 pub fn authorize_by_policy(&mut self,invoice:Invoice,merchant_id:String,expires_at:Option<U64>)->Payment {
  near_sdk::require!(env::predecessor_account_id()==self.executor,"executor only");
  merchant_auth::require_unsigned(&merchant_id);
  self.authorize_policy_invoice(invoice,merchant_id,expires_at)
 }
}
// Internal shared implementation: this impl has no NEAR export macro.
impl Contract {
 pub(super) fn authorize_policy_invoice(&mut self,invoice:Invoice,merchant_id:String,expires_at:Option<U64>)->Payment {
  let policy=policies().get(&0).unwrap_or_else(||env::panic_str("no spending policy"));
  check(&policy,&invoice,&merchant_id);
  // Same invoice terms/merchant may be retried; never charge quota twice.
  if let Some(p)=self.payments.get(&invoice.id){
   let b=bindings().get(&invoice.id).unwrap_or_else(||env::panic_str("invoice id already used"));
   near_sdk::require!(b.version==policy.version.0 && b.merchant==merchant_id && p.commitment==commitment(&invoice),"policy invoice mismatch");
   near_sdk::require!(p.state!=State::Cancelled,"invoice cancelled");check_expiry(&invoice.id);return p;
  }
  let mut charges=active(self);
  near_sdk::require!(charges.len()<MAX_CHARGES,"policy history capacity reached");
  let used=total(&charges);near_sdk::require!(invoice.amount.0<=policy.daily_limit.0.saturating_sub(used),"rolling daily budget exceeded");
  let expiry=expires_at.unwrap_or(U64(env::block_timestamp_ms().saturating_add(3_600_000).min(policy.expires_at.0)));
  near_sdk::require!(expiry.0<=policy.expires_at.0,"invoice outlives policy");
  let p=self.record_authorization(invoice.clone(),Some(expiry));
  bindings().insert(&invoice.id,&Binding{version:policy.version.0,merchant:merchant_id});
  charges.push(Charge{invoice_id:invoice.id,amount:invoice.amount.0,dispatched_at:None});ledger().insert(&0,&charges);p
 }
}

#[cfg(test)]
mod tests {
 use super::*;
 use near_sdk::{test_utils::VMContextBuilder,testing_env};
 fn context(actor:&str,ms:u64){let mut b=VMContextBuilder::new();b.predecessor_account_id(actor.parse().unwrap()).block_timestamp(ms*1_000_000);testing_env!(b.build());}
 fn setup()->Contract{
  context("owner.near",1000);
  let mut c=Contract::new("owner.near".parse().unwrap(),"executor.near".parse().unwrap());
  c.set_policy(vec![Merchant{id:"merchant".into(),payee:"merchant.near".parse().unwrap()}],U128(100),U128(200),U64(3*WINDOW));c
 }
 fn invoice(id:&str)->Invoice{Invoice{id:id.into(),payee:"merchant.near".parse().unwrap(),asset:"near".into(),amount:U128(100)}}
 #[test] fn rolling_window_counts_pending_and_uncertain_but_ages_settled_dispatches(){
  let mut c=setup();context("executor.near",1000);
  c.authorize_by_policy(invoice("settled"),"merchant".into(),None);
  record_execution(&invoice("settled"));
  let mut paid=c.payments.get(&"settled".into()).unwrap();paid.state=State::Settled;c.payments.insert(&"settled".into(),&paid);
  c.authorize_by_policy(invoice("pending"),"merchant".into(),None);
  context("executor.near",WINDOW+999);assert_eq!(c.policy_usage().0,200);
  context("executor.near",WINDOW+1000);assert_eq!(c.policy_usage().0,100);
  // An uncertain dispatched payment remains held even beyond 24h.
  record_execution(&invoice("pending"));let mut p=c.payments.get(&"pending".into()).unwrap();p.state=State::Executing;c.payments.insert(&"pending".into(),&p);
  context("executor.near",3*WINDOW);assert_eq!(c.policy_usage().0,100);
 }
 #[test] fn updating_policy_cannot_reset_holds_and_retry_cannot_charge_twice(){
  let mut c=setup();context("executor.near",1000);
  c.authorize_by_policy(invoice("one"),"merchant".into(),None);
  c.authorize_by_policy(invoice("one"),"merchant".into(),None);assert_eq!(c.policy_usage().0,100);
  context("owner.near",2000);c.set_policy(vec![Merchant{id:"merchant".into(),payee:"merchant.near".parse().unwrap()}],U128(100),U128(100),U64(WINDOW));assert_eq!(c.policy_usage().0,100);
  c.cancel("one".into());c.cancel("one".into());assert_eq!(c.policy_usage().0,0);
 }
 #[test] #[should_panic(expected="merchant payout mismatch")] fn merchant_identity_cannot_redirect_payment(){
  let mut c=setup();context("executor.near",1000);let mut i=invoice("bad");i.payee="attacker.near".parse().unwrap();c.authorize_by_policy(i,"merchant".into(),None);
 }
}
