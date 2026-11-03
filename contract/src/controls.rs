use super::*;
fn pauses()->LookupMap<u8,bool>{LookupMap::new(b"vault-paused-v1".to_vec())}
pub(super) fn require_running(){near_sdk::require!(!pauses().get(&0).unwrap_or(false),"vault payments paused");}
#[near(serializers=[json])]
pub struct VaultControls {pub owner:AccountId,pub executor:AccountId,pub paused:bool}
#[near]
impl Contract {
 pub fn get_vault_controls(&self)->VaultControls {VaultControls{owner:self.owner.clone(),executor:self.executor.clone(),paused:pauses().get(&0).unwrap_or(false)}}
 pub fn set_paused(&mut self,paused:bool)->VaultControls{
  near_sdk::require!(env::predecessor_account_id()==self.owner,"owner only");
  pauses().insert(&0,&paused);self.get_vault_controls()
 }
 pub fn set_executor(&mut self,executor:AccountId)->VaultControls{
  near_sdk::require!(env::predecessor_account_id()==self.owner,"owner only");
  near_sdk::require!(pauses().get(&0).unwrap_or(false),"pause before replacing executor");
  near_sdk::require!(executor!=self.owner&&executor!=env::current_account_id(),"executor must be separate from owner and vault");
  self.executor=executor;self.get_vault_controls()
 }
}
#[cfg(test)]
mod tests {
 use super::*;
 use near_sdk::{testing_env,test_utils::VMContextBuilder,PromiseResult};
 fn context(actor:&str)->near_sdk::VMContext{let mut b=VMContextBuilder::new();b.current_account_id("vault.near".parse().unwrap()).predecessor_account_id(actor.parse().unwrap());b.build()}
 fn setup()->Contract{testing_env!(context("owner.near"));let mut c=Contract::new("owner.near".parse().unwrap(),"executor.near".parse().unwrap());c.available=100;c}
 fn invoice()->Invoice{Invoice{id:"held".into(),payee:"merchant.near".parse().unwrap(),asset:"near".into(),amount:U128(42)}}
 #[test] #[should_panic(expected="owner only")] fn executor_cannot_unpause(){let mut c=setup();c.set_paused(true);testing_env!(context("executor.near"));c.set_paused(false);}
 #[test] #[should_panic(expected="pause before replacing executor")] fn rotation_requires_pause(){let mut c=setup();c.set_executor("replacement.near".parse().unwrap());}
 #[test] #[should_panic(expected="vault payments paused")] fn owner_cannot_authorize_while_paused(){let mut c=setup();c.set_paused(true);c.authorize(invoice(),None);}
 #[test] fn pause_preserves_holds_and_allows_confirmed_cancellation(){
  let mut c=setup();assert!(!c.get_vault_controls().paused);c.authorize(invoice(),None);
  testing_env!(context("executor.near"));c.reserve(invoice(),"attempt".into());
  testing_env!(context("owner.near"));c.set_paused(true);c.set_executor("replacement.near".parse().unwrap());
  assert_eq!(c.available,58);assert_eq!(c.get_payment("held".into()).unwrap().state,State::Reserved);
  expiries().insert(&"held".into(),&0);c.cancel("held".into());assert_eq!(c.available,100);assert!(c.get_vault_controls().paused);
 }
 #[test] fn in_flight_callbacks_finish_while_paused_and_after_executor_replacement(){
  for failed in [false,true]{
   let mut c=setup();let i=Invoice{id:if failed{"failure"}else{"success"}.into(),..invoice()};c.authorize(i.clone(),None);
   testing_env!(context("executor.near"));let mut p=c.reserve(i.clone(),"attempt".into());p.state=State::Executing;c.payments.insert(&i.id,&p);
   testing_env!(context("owner.near"));c.set_paused(true);c.set_executor("replacement.near".parse().unwrap());
   #[allow(deprecated)]
   near_sdk::test_utils::testing_env_with_promise_results(context("vault.near"),if failed{PromiseResult::Failed}else{PromiseResult::Successful(vec![])});
   let p=c.on_transfer(i.id,"attempt".into());assert_eq!(p.state,if failed{State::Failed}else{State::Settled});assert_eq!(c.available,if failed{100}else{58});
   assert!(c.get_vault_controls().paused);
   // Clear only the test pause flag before the second independent fixture.
   pauses().remove(&0);
  }
 }
}
