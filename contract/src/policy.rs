use super::*;
const WINDOW: u64=86_400_000;
const MAX_CHARGES: usize=128;
const MAX_PENDING: usize=16;
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
fn minimums()->LookupMap<u8,u128>{LookupMap::new(b"policy-minimum-v1".to_vec())}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct PolicyRenewal {pub renewal_id:String,pub previous_version:U64,pub version:U64,pub expires_at:U64}
fn renewals()->LookupMap<String,PolicyRenewal>{LookupMap::new(b"policy-renewals-v1".to_vec())}
fn active(c:&Contract)->Vec<Charge>{
 let now=env::block_timestamp_ms();
 ledger().get(&0).unwrap_or_default().into_iter().filter(|e|{
  let Some(payment)=c.payments.get(&e.invoice_id) else{return true;}; // Missing evidence keeps the hold.
  match payment.state {
   State::Authorized => !(e.dispatched_at.is_none() && payment.attempt_id.is_none()
    && expiries().get(&e.invoice_id).is_some_and(|expiry|now>=expiry)),
   State::Reserved | State::Executing => true,
   State::Settled => e.dispatched_at.is_none_or(|t|now.saturating_sub(t)<WINDOW),
   State::Failed | State::Cancelled => false,
  }
 }).collect()
}
fn pending(charges:&[Charge])->usize{charges.iter().filter(|e|e.dispatched_at.is_none()).count()}
fn total(charges:&[Charge])->u128{charges.iter().fold(0u128,|n,e|n.checked_add(e.amount).unwrap_or_else(||env::panic_str("policy accounting overflow")))}
fn check(policy:&SpendingPolicy,invoice:&Invoice,merchant:&str){
 near_sdk::require!(env::block_timestamp_ms()<policy.expires_at.0,"policy expired");
 let entry=policy.merchants.iter().find(|m|m.id==merchant).unwrap_or_else(||env::panic_str("merchant not allowed"));
 near_sdk::require!(entry.payee==invoice.payee,"merchant payout mismatch");
 near_sdk::require!(invoice.asset=="near" && invoice.amount.0>0,"only positive native NEAR supported");
 near_sdk::require!(invoice.amount.0<=policy.per_payment.0,"per-payment cap exceeded");
 near_sdk::require!(invoice.amount.0>=minimums().get(&0).unwrap_or(1),"below policy minimum");
}
pub(super) fn invalidated(invoice_id:&String)->bool{
 bindings().get(invoice_id).is_some_and(|binding|policies().get(&0).is_none_or(|p|p.version.0!=binding.version))
}
pub(super) fn check_bound(invoice:&Invoice){
 if let Some(binding)=bindings().get(&invoice.id){
  let policy=policies().get(&0).unwrap_or_else(||env::panic_str("policy revoked"));
  near_sdk::require!(policy.version.0==binding.version,"policy changed; approval invalidated");
  check(&policy,invoice,&binding.merchant);
  merchant_auth::check_bound(invoice,&binding.merchant);
  service::check_bound(invoice, &binding.merchant);
 } else {
  // Also cover manual approvals issued before the payee opted into weekly billing.
  service::require_manual_payee(&invoice.payee);
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
#[near(serializers=[json])]
pub struct PolicyCapacity {pub min_payment:U128,pub max_pending:u32,pub max_charges:u32,pub pending:u32,pub charges:u32,pub usage:U128}
#[near(serializers=[json])]
pub struct PolicySnapshot {pub policy:Option<SpendingPolicy>,pub min_payment:U128,pub usage:U128,pub now:U64}
#[near]
impl Contract {
 // Renewal changes only expiry/version. No caller-supplied merchant, amount or
 // minimum can overwrite the existing rules, and no ledger entry is removed.
 pub fn renew_policy(&mut self,renewal_id:String,expected_version:U64,expires_at:U64)->SpendingPolicy{
  near_sdk::require!(env::predecessor_account_id()==self.owner,"owner only");
  near_sdk::require!(valid_id(&renewal_id),"invalid renewal id");
  let mut p=policies().get(&0).unwrap_or_else(||env::panic_str("no spending policy"));
  if let Some(receipt)=renewals().get(&renewal_id){
   near_sdk::require!(receipt.previous_version==expected_version&&receipt.expires_at==expires_at,"renewal id already bound");
   near_sdk::require!(p.version==receipt.version&&p.expires_at==expires_at,"renewal superseded");
   return p; // A late retry never extends expiry again, even if now expired.
  }
  near_sdk::require!(p.version==expected_version,"policy changed; renewal must be reviewed");
  let now=env::block_timestamp_ms();
  near_sdk::require!(expires_at.0>now&&expires_at.0<=now.saturating_add(30*WINDOW),"renewal expiry must be within 30 days");
  near_sdk::require!(expires_at.0>p.expires_at.0,"renewal must extend policy expiry");
  let version=versions().get(&0).unwrap_or(0).checked_add(1).unwrap_or_else(||env::panic_str("policy version overflow"));
  p.version=U64(version);p.expires_at=expires_at;
  versions().insert(&0,&version);policies().insert(&0,&p);
  renewals().insert(&renewal_id,&PolicyRenewal{renewal_id:renewal_id.clone(),previous_version:expected_version,version:p.version,expires_at});p
 }
 pub fn get_policy_renewal(&self,renewal_id:String)->Option<PolicyRenewal>{renewals().get(&renewal_id)}
 pub fn policy_snapshot(&self)->PolicySnapshot{PolicySnapshot{policy:policies().get(&0),min_payment:U128(minimums().get(&0).unwrap_or(1)),usage:self.policy_usage(),now:U64(env::block_timestamp_ms())}}
 pub fn set_policy(&mut self,merchants:Vec<Merchant>,per_payment:U128,daily_limit:U128,expires_at:U64,min_payment:Option<U128>)->SpendingPolicy {
  near_sdk::require!(env::predecessor_account_id()==self.owner,"owner only");
  near_sdk::require!(!merchants.is_empty()&&merchants.len()<=32,"one to 32 merchants required");
  for (i,m) in merchants.iter().enumerate(){near_sdk::require!(valid_id(&m.id)&&!merchants[..i].iter().any(|x|x.id==m.id),"invalid or duplicate merchant id");}
  near_sdk::require!(per_payment.0>0 && daily_limit.0>=per_payment.0,"invalid policy limits");
  let minimum=min_payment.map(|v|v.0).unwrap_or(per_payment.0/100+u128::from(per_payment.0%100!=0));
  near_sdk::require!(minimum>0&&minimum<=per_payment.0,"invalid policy minimum");
  let now=env::block_timestamp_ms();near_sdk::require!(expires_at.0>now&&expires_at.0<=now.saturating_add(30*WINDOW),"policy expiry must be within 30 days");
  let version=versions().get(&0).unwrap_or(0).checked_add(1).unwrap_or_else(||env::panic_str("policy version overflow"));
  let p=SpendingPolicy{version:U64(version),merchants,per_payment,daily_limit,expires_at};
  versions().insert(&0,&version);minimums().insert(&0,&minimum);policies().insert(&0,&p);p
 }
 pub fn revoke_policy(&mut self){near_sdk::require!(env::predecessor_account_id()==self.owner,"owner only");policies().remove(&0);}
 pub fn get_policy(&self)->Option<SpendingPolicy>{policies().get(&0)}
 pub fn policy_usage(&self)->U128{U128(total(&active(self)))}
 pub fn policy_capacity(&self)->PolicyCapacity{
  let charges=active(self);PolicyCapacity{min_payment:U128(minimums().get(&0).unwrap_or(1)),max_pending:MAX_PENDING as u32,max_charges:MAX_CHARGES as u32,pending:pending(&charges) as u32,charges:charges.len() as u32,usage:U128(total(&charges))}
 }
 // Owner recovery of abandoned approvals, including legacy ledgers at capacity.
 // Never touches Reserved/Executing records, vault balance, or invoice/bill bindings.
 pub fn clear_policy_approvals(&mut self)->Vec<String>{
  near_sdk::require!(env::predecessor_account_id()==self.owner,"owner only");
  let charges=ledger().get(&0).unwrap_or_default();let mut cleared=Vec::new();
  for charge in &charges {
   if let Some(mut p)=self.payments.get(&charge.invoice_id){
    if p.state==State::Authorized&&p.attempt_id.is_none()&&charge.dispatched_at.is_none(){
     p.state=State::Cancelled;self.payments.insert(&charge.invoice_id,&p);cleared.push(charge.invoice_id.clone());
    }
   }
  }
  ledger().insert(&0,&active(self));cleared
 }
 pub fn authorize_by_policy(&mut self,invoice:Invoice,merchant_id:String,expires_at:Option<U64>)->Payment {
  near_sdk::require!(env::predecessor_account_id()==self.executor,"executor only");
  merchant_auth::require_unsigned(&merchant_id);
  service::require_unprotected(&invoice, &merchant_id);
  self.authorize_policy_invoice(invoice,merchant_id,expires_at)
 }
}
// Internal shared implementation: this impl has no NEAR export macro.
impl Contract {
 pub(super) fn authorize_policy_invoice(&mut self,invoice:Invoice,merchant_id:String,expires_at:Option<U64>)->Payment {
  controls::require_running();
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
  near_sdk::require!(pending(&charges)<MAX_PENDING,"pending policy capacity reached");
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
  c.set_policy(vec![Merchant{id:"merchant".into(),payee:"merchant.near".parse().unwrap()}],U128(100),U128(200),U64(3*WINDOW),None);c
 }
 fn invoice(id:&str)->Invoice{Invoice{id:id.into(),payee:"merchant.near".parse().unwrap(),asset:"near".into(),amount:U128(100)}}
 #[test] fn rolling_window_counts_pending_and_uncertain_but_ages_settled_dispatches(){
  let mut c=setup();context("executor.near",1000);
  c.authorize_by_policy(invoice("settled"),"merchant".into(),None);
  record_execution(&invoice("settled"));
  let mut paid=c.payments.get(&"settled".into()).unwrap();paid.state=State::Settled;c.payments.insert(&"settled".into(),&paid);
  c.authorize_by_policy(invoice("pending"),"merchant".into(),None);
  c.available=100;c.reserve(invoice("pending"),"held".into());
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
  context("owner.near",2000);c.set_policy(vec![Merchant{id:"merchant".into(),payee:"merchant.near".parse().unwrap()}],U128(100),U128(100),U64(WINDOW),None);assert_eq!(c.policy_usage().0,100);
  c.cancel("one".into());c.cancel("one".into());assert_eq!(c.policy_usage().0,0);
 }
 #[test] #[should_panic(expected="merchant payout mismatch")] fn merchant_identity_cannot_redirect_payment(){
  let mut c=setup();context("executor.near",1000);let mut i=invoice("bad");i.payee="attacker.near".parse().unwrap();c.authorize_by_policy(i,"merchant".into(),None);
 }
 #[test] fn expiry_releases_only_never_reserved_approvals_and_preserves_ids(){
  let mut c=setup();c.available=1000;context("executor.near",1000);
  for id in ["expired","reserved","executing","legacy"]{
   c.authorize_by_policy(Invoice{amount:U128(25),..invoice(id)},"merchant".into(),Some(U64(5000)));
  }
  expiries().remove(&"legacy".into()); // Missing legacy expiry must retain its charge.
  for id in ["reserved","executing"]{c.reserve(Invoice{amount:U128(25),..invoice(id)},id.into());}
  record_execution(&invoice("executing"));let mut p=c.payments.get(&"executing".into()).unwrap();p.state=State::Executing;c.payments.insert(&"executing".into(),&p);
  context("executor.near",4999);assert_eq!(c.policy_usage().0,100);
  context("executor.near",5000);assert_eq!(c.policy_usage().0,75);assert_eq!(c.available,950);
  // Persist pruning with a new approval; the expired ID still cannot be rebound.
  c.authorize_by_policy(Invoice{amount:U128(25),..invoice("new")},"merchant".into(),None);
  assert_eq!(ledger().get(&0).unwrap().len(),4);assert!(c.get_payment("expired".into()).is_some());
  context("owner.near",3*WINDOW);assert_eq!(c.policy_usage().0,75); // Reserved + Executing + expiry-less legacy.
  c.cancel("reserved".into());assert_eq!(c.available,975);assert_eq!(c.policy_usage().0,50);
 }
 #[test] #[should_panic(expected="below policy minimum")] fn minimum_blocks_dust_authorization(){
  let mut c=setup();c.set_policy(vec![Merchant{id:"merchant".into(),payee:"merchant.near".parse().unwrap()}],U128(1000),U128(2000),U64(WINDOW),None);
  assert_eq!(c.policy_capacity().min_payment.0,10);context("executor.near",1000);
  c.authorize_by_policy(Invoice{amount:U128(1),..invoice("dust")},"merchant".into(),None);
 }
 #[test] #[should_panic(expected="pending policy capacity reached")] fn pending_limit_cannot_consume_entire_history(){
  let mut c=setup();context("executor.near",1000);
  for n in 0..=MAX_PENDING{c.authorize_by_policy(Invoice{amount:U128(1),..invoice(&format!("tiny-{n}"))},"merchant".into(),None);}
 }
 #[test] fn bounded_owner_cleanup_recovers_full_legacy_ledger_without_releasing_reserved_or_executing(){
  let mut c=setup();c.available=999;
  let charges=(0..MAX_CHARGES).map(|n|{
   let invoice=Invoice{amount:U128(1),..invoice(&format!("legacy-{n}"))};let id=invoice.id.clone();
   c.payments.insert(&id,&Payment{commitment:commitment(&invoice),invoice,state:if n==0{State::Reserved}else if n==1{State::Executing}else{State::Authorized},attempt_id:if n<2{Some(id.clone())}else{None}});
   Charge{invoice_id:id,amount:1,dispatched_at:if n==1{Some(1000)}else{None}}
  }).collect();ledger().insert(&0,&charges);
  context("owner.near",1000);c.set_paused(true);
  assert_eq!(c.clear_policy_approvals().len(),126);assert!(env::used_gas().as_tgas()<250);
  assert_eq!(c.policy_usage().0,2);assert_eq!(c.available,999);assert!(c.clear_policy_approvals().is_empty());
  assert_eq!(c.get_payment("legacy-0".into()).unwrap().state,State::Reserved);
  assert_eq!(c.get_payment("legacy-1".into()).unwrap().state,State::Executing);
 }
 #[test] #[should_panic(expected="owner only")] fn executor_cannot_clear_policy_approvals(){let mut c=setup();context("executor.near",1000);c.clear_policy_approvals();}
 #[test] fn policy_change_allows_owner_to_cancel_only_unexecuted_reservations_once(){
  let mut c=setup();c.available=300;context("executor.near",1000);
  c.authorize_by_policy(invoice("held"),"merchant".into(),None);c.reserve(invoice("held"),"held".into());
  context("owner.near",1001);c.revoke_policy();assert_eq!(c.policy_usage().0,100);
  c.cancel("held".into());c.cancel("held".into());assert_eq!(c.available,300);assert_eq!(c.policy_usage().0,0);
 }
 #[test] #[should_panic(expected="only authorized or expired reserved invoices can be cancelled")] fn revoked_executing_payment_cannot_be_cancelled(){
  let mut c=setup();c.available=300;context("executor.near",1000);
  c.authorize_by_policy(invoice("flight"),"merchant".into(),None);let mut p=c.reserve(invoice("flight"),"flight".into());p.state=State::Executing;c.payments.insert(&"flight".into(),&p);
  context("owner.near",1001);c.revoke_policy();c.cancel("flight".into());
 }
 #[test] fn renewal_preserves_terms_and_pending_holds_and_retries_do_not_extend_expiry(){
  let mut c=setup();c.available=300;context("executor.near",1000);
  c.authorize_by_policy(invoice("held"),"merchant".into(),None);c.reserve(invoice("held"),"held".into());
  c.authorize_by_policy(invoice("in-flight"),"merchant".into(),None);c.reserve(invoice("in-flight"),"flight".into());
  record_execution(&invoice("in-flight"));let mut flight=c.payments.get(&"in-flight".into()).unwrap();flight.state=State::Executing;c.payments.insert(&"in-flight".into(),&flight);
  let old=c.get_policy().unwrap();let budget=c.available;
  context("owner.near",3*WINDOW+1);c.set_paused(true);
  let next=c.renew_policy("renew-once".into(),old.version,U64(4*WINDOW));
  assert_eq!(next.per_payment,old.per_payment);assert_eq!(next.daily_limit,old.daily_limit);assert_eq!(next.merchants[0].id,old.merchants[0].id);assert_eq!(next.merchants[0].payee,old.merchants[0].payee);
  assert_eq!(c.policy_usage().0,200);assert_eq!(c.available,budget);assert_eq!(c.policy_capacity().min_payment.0,1);
  context("owner.near",5*WINDOW);let retry=c.renew_policy("renew-once".into(),old.version,U64(4*WINDOW));
  assert_eq!(retry.version,next.version);assert_eq!(retry.expires_at,U64(4*WINDOW));assert_eq!(c.policy_usage().0,200);
  assert!(c.get_policy_renewal("renew-once".into()).is_some());
 }
 #[test] #[should_panic(expected="owner only")] fn executor_cannot_renew_policy(){let mut c=setup();context("executor.near",1000);c.renew_policy("r".into(),U64(1),U64(4*WINDOW));}
 #[test] #[should_panic(expected="policy changed; renewal must be reviewed")] fn stale_renewal_cannot_overwrite_new_rules(){let mut c=setup();c.renew_policy("first".into(),U64(1),U64(4*WINDOW));c.renew_policy("stale".into(),U64(1),U64(5*WINDOW));}
 #[test] #[should_panic(expected="renewal id already bound")] fn renewal_id_cannot_change_its_deadline(){let mut c=setup();c.renew_policy("same".into(),U64(1),U64(4*WINDOW));c.renew_policy("same".into(),U64(1),U64(5*WINDOW));}
 #[test] #[should_panic(expected="renewal superseded")] fn old_renewal_cannot_restore_a_replaced_policy(){let mut c=setup();c.renew_policy("first".into(),U64(1),U64(4*WINDOW));c.renew_policy("later".into(),U64(2),U64(5*WINDOW));c.renew_policy("first".into(),U64(1),U64(4*WINDOW));}
 #[test] #[should_panic(expected="invoice expired")] fn renewal_cannot_revive_an_expired_invoice(){let mut c=setup();context("executor.near",1000);c.authorize_by_policy(invoice("expired"),"merchant".into(),Some(U64(2000)));context("owner.near",3*WINDOW+1);c.renew_policy("r".into(),U64(1),U64(4*WINDOW));context("executor.near",3*WINDOW+2);c.reserve(invoice("expired"),"a".into());}
 #[test] #[should_panic(expected="renewal expiry must be within 30 days")] fn renewal_cannot_create_unbounded_authority(){let mut c=setup();c.renew_policy("r".into(),U64(1),U64(40*WINDOW));}
 #[test] fn renewal_keeps_legacy_minimum_and_custom_minimum(){
  let mut c=setup();minimums().remove(&0);c.renew_policy("legacy".into(),U64(1),U64(4*WINDOW));assert!(minimums().get(&0).is_none());assert_eq!(c.policy_snapshot().min_payment.0,1);
  c.set_policy(vec![Merchant{id:"merchant".into(),payee:"merchant.near".parse().unwrap()}],U128(100),U128(200),U64(5*WINDOW),Some(U128(7)));
  c.renew_policy("custom".into(),U64(3),U64(6*WINDOW));assert_eq!(c.policy_snapshot().min_payment.0,7);
 }

}
