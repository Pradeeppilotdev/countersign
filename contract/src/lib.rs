use near_sdk::{collections::LookupMap, env, json_types::{U128, U64}, near, AccountId, PanicOnDefault, NearToken, Gas, Promise, PromiseOrValue};

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum State { Authorized, Reserved, Executing, Settled, Failed }

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Invoice { pub id: String, pub payee: AccountId, pub asset: String, pub amount: U128 }

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Payment { pub invoice: Invoice, pub commitment: String, pub state: State, pub attempt_id: Option<String> }

// Separate storage prefix preserves the existing native-vault state layout.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct DryRoute {
    pub invoice_id: String, pub origin_asset: String, pub destination_asset: String,
    pub recipient: String, pub refund_to: String, pub amount_out: U128,
    pub max_amount_in: U128, pub quoted_amount_in: U128, pub expires_at: U64,
    pub quote_hash: String, pub response_hash: String,
}
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct RouteApproval { pub route: DryRoute, pub commitment: String }
fn routes() -> LookupMap<String, RouteApproval> { LookupMap::new(b"dry-routes-v1".to_vec()) }
fn route_commitment(r: &DryRoute) -> String {
    let mut bytes=b"NEAR-AEGIS-DRY-ROUTE-V1\n".to_vec();
    for field in [env::current_account_id().to_string(),r.invoice_id.clone(),r.origin_asset.clone(),r.destination_asset.clone(),r.recipient.clone(),r.refund_to.clone(),r.amount_out.0.to_string(),r.max_amount_in.0.to_string(),r.quoted_amount_in.0.to_string(),r.expires_at.0.to_string(),r.quote_hash.clone(),r.response_hash.clone()] {
        bytes.extend_from_slice(format!("{}:",field.len()).as_bytes());bytes.extend_from_slice(field.as_bytes());
    }
    env::sha256(&bytes).iter().map(|b|format!("{:02x}",b)).collect()
}
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract { owner: AccountId, executor: AccountId, payments: LookupMap<String, Payment>, available: u128 }

// Exact UTF-8 encoding: domain + newline, then each string as its byte length,
// colon, bytes; amount is a canonical positive base-10 integer string.
fn canonical(i: &Invoice) -> Vec<u8> {
    let mut b = b"NEAR-AEGIS-INVOICE-V1\n".to_vec();
    let amount = i.amount.0.to_string();
    let fields: [&str; 4] = [&i.id, i.payee.as_str(), &i.asset, &amount];
    for s in fields {
        b.extend_from_slice(format!("{}:", s.len()).as_bytes()); b.extend_from_slice(s.as_bytes());
    }
    b
}
fn commitment(i: &Invoice) -> String { env::sha256(&canonical(i)).iter().map(|b| format!("{:02x}", b)).collect() }
fn valid_id(s: &str) -> bool { !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.:".contains(&b)) }

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, executor: AccountId) -> Self { Self { owner, executor, payments: LookupMap::new(b"p"), available: 0 } }
    #[payable]
    pub fn fund(&mut self) {
        near_sdk::require!(env::predecessor_account_id() == self.owner, "owner only");
        self.available = self.available.checked_add(env::attached_deposit().as_yoctonear()).unwrap_or_else(|| env::panic_str("overflow"));
    }
    // Approval records consent to a dry preview only. No deposit address, transfer or budget reservation.
    pub fn authorize_route(&mut self, route: DryRoute) -> RouteApproval {
        near_sdk::require!(env::predecessor_account_id() == self.owner, "owner only");
        near_sdk::require!(valid_id(&route.invoice_id), "invalid invoice id");
        for field in [&route.origin_asset,&route.destination_asset,&route.recipient,&route.refund_to] {
            near_sdk::require!(!field.is_empty() && field.len()<=256 && field.trim()==field, "invalid route field");
        }
        near_sdk::require!(route.quote_hash.len()>=32 && route.quote_hash.len()<=64 && route.quote_hash.bytes().all(|b|b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&b)), "invalid quote hash");
        for hash in [&route.response_hash] {
            near_sdk::require!(hash.len()==64 && hash.bytes().all(|b|b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "invalid hash");
        }
        near_sdk::require!(route.amount_out.0>0 && route.quoted_amount_in.0>0 && route.quoted_amount_in.0<=route.max_amount_in.0, "invalid amount limits");
        let now=env::block_timestamp_ms();
        near_sdk::require!(route.expires_at.0>now && route.expires_at.0<=now.saturating_add(60_000), "expired or excessive route lifetime");
        near_sdk::require!(self.payments.get(&route.invoice_id).is_none(), "invoice id already used");
        let approval=RouteApproval{commitment:route_commitment(&route),route:route.clone()};
        if let Some(old)=routes().get(&route.invoice_id) {
            near_sdk::require!(old.commitment==approval.commitment,"route already bound");return old;
        }
        routes().insert(&route.invoice_id,&approval);approval
    }
    pub fn get_route(&self, invoice_id:String)->Option<RouteApproval>{routes().get(&invoice_id)}
    pub fn check_route(&self, route:DryRoute)->RouteApproval{
        let approval=routes().get(&route.invoice_id).unwrap_or_else(|| env::panic_str("unknown route"));
        near_sdk::require!(approval.commitment==route_commitment(&route),"route mismatch");
        near_sdk::require!(route.expires_at.0>env::block_timestamp_ms(),"route expired");approval
    }
    pub fn available_balance(&self) -> U128 { U128(self.available) }
    pub fn authorize(&mut self, invoice: Invoice) -> Payment {
        near_sdk::require!(env::predecessor_account_id() == self.owner, "owner only");
        near_sdk::require!(valid_id(&invoice.id) && valid_id(&invoice.asset) && invoice.amount.0 > 0, "invalid invoice");
        near_sdk::require!(invoice.asset == "near", "only native NEAR supported");
        near_sdk::require!(self.payments.get(&invoice.id).is_none() && routes().get(&invoice.id).is_none(), "invoice id already used");
        let p = Payment { commitment: commitment(&invoice), invoice: invoice.clone(), state: State::Authorized, attempt_id: None };
        self.payments.insert(&invoice.id, &p); p
    }
    pub fn reserve(&mut self, invoice: Invoice, attempt_id: String) -> Payment {
        near_sdk::require!(env::predecessor_account_id() == self.executor, "executor only");
        near_sdk::require!(valid_id(&attempt_id), "invalid attempt id");
        let mut p = self.payments.get(&invoice.id).unwrap_or_else(|| env::panic_str("unknown invoice"));
        near_sdk::require!(p.commitment == commitment(&invoice), "invoice mismatch");
        if p.state != State::Authorized {
            near_sdk::require!(p.attempt_id.as_deref() == Some(attempt_id.as_str()), "already reserved");
            return p;
        }
        near_sdk::require!(self.available >= invoice.amount.0, "insufficient budget");
        self.available -= invoice.amount.0;
        p.state = State::Reserved; p.attempt_id = Some(attempt_id);
        self.payments.insert(&invoice.id, &p); p
    }
    pub fn execute(&mut self, invoice_id: String, attempt_id: String) -> PromiseOrValue<Payment> {
        near_sdk::require!(env::predecessor_account_id() == self.executor, "executor only");
        let mut p = self.payments.get(&invoice_id).unwrap_or_else(|| env::panic_str("unknown invoice"));
        near_sdk::require!(p.attempt_id.as_deref() == Some(attempt_id.as_str()), "attempt mismatch");
        if matches!(p.state, State::Executing | State::Settled | State::Failed) { return PromiseOrValue::Value(p); }
        near_sdk::require!(p.state == State::Reserved, "not reserved");
        let storage = u128::from(env::storage_usage()) * env::storage_byte_cost().as_yoctonear();
        near_sdk::require!(env::account_balance().as_yoctonear().saturating_sub(storage + 100_000_000_000_000_000_000_000) >= p.invoice.amount.0, "insufficient liquid balance");
        p.state = State::Executing;
        self.payments.insert(&invoice_id, &p);
        PromiseOrValue::Promise(Promise::new(p.invoice.payee.clone())
            .transfer(NearToken::from_yoctonear(p.invoice.amount.0))
            .then(Promise::new(env::current_account_id()).function_call(
                "on_transfer", near_sdk::serde_json::to_vec(&(near_sdk::serde_json::json!({"invoice_id":invoice_id,"attempt_id":attempt_id}))).unwrap(),
                NearToken::from_yoctonear(0), Gas::from_tgas(10))))
    }
    #[private]
    pub fn on_transfer(&mut self, invoice_id: String, attempt_id: String) -> Payment {
        near_sdk::require!(env::predecessor_account_id() == env::current_account_id(), "private callback");
        near_sdk::require!(env::promise_results_count() == 1, "one transfer result required");
        let mut p = self.payments.get(&invoice_id).unwrap_or_else(|| env::panic_str("unknown invoice"));
        near_sdk::require!(p.attempt_id.as_deref() == Some(attempt_id.as_str()), "attempt mismatch");
        near_sdk::require!(p.state == State::Executing, "invalid transition");
        p.state = match env::promise_result_checked(0, 0) { Ok(_) => State::Settled, Err(_) => State::Failed };
        // Failed transfers remain charged to the budget: no automatic refund reuse/retry.
        self.payments.insert(&invoice_id, &p); p
    }
    pub fn get_payment(&self, invoice_id: String) -> Option<Payment> { self.payments.get(&invoice_id) }
    pub fn invoice_commitment(&self, invoice: Invoice) -> String { commitment(&invoice) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};
    fn actor(s: &str) { let mut c = VMContextBuilder::new(); c.predecessor_account_id(s.parse().unwrap()); testing_env!(c.build()); }
    fn invoice() -> Invoice { Invoice { id: "inv-1".into(), payee: "merchant.near".parse().unwrap(), asset: "near".into(), amount: U128(42) } }
    #[test] fn commitment_vector() { let mut i = invoice(); i.asset = "usdc".into(); assert_eq!(commitment(&i), "b5561ba22a6b4bfd4d3cc91550e27bf7e5629730521b3f648266008bae0d5506"); }
    #[test] #[should_panic(expected = "owner only")] fn unauthorized_owner_call_rejected() {
        actor("attacker.near"); let mut c = Contract::new("owner.near".parse().unwrap(), "executor.near".parse().unwrap()); c.available = 1000; c.authorize(invoice());
    }
    #[test] #[should_panic(expected = "executor only")] fn unauthorized_reservation_rejected() {
        actor("owner.near"); let mut c = Contract::new("owner.near".parse().unwrap(), "executor.near".parse().unwrap()); c.available = 1000; c.authorize(invoice());
        actor("attacker.near"); c.reserve(invoice(), "a".into());
    }
    #[test] #[should_panic(expected = "invoice mismatch")] fn altered_payee_rejected() {
        actor("owner.near"); let mut c = Contract::new("owner.near".parse().unwrap(), "executor.near".parse().unwrap()); c.available = 1000; c.authorize(invoice());
        actor("executor.near"); let mut i = invoice(); i.payee = "attacker.near".parse().unwrap(); c.reserve(i, "a".into());
    }
    #[test] fn reservation_debits_budget_once() {
        actor("owner.near"); let mut c = Contract::new("owner.near".parse().unwrap(), "executor.near".parse().unwrap()); c.available = 100; c.authorize(invoice());
        actor("executor.near"); c.reserve(invoice(), "a".into()); c.reserve(invoice(), "a".into()); assert_eq!(c.available, 58);
    }
    #[test] #[should_panic(expected = "invoice mismatch")] fn tampering_rejected() {
        actor("owner.near"); let mut c = Contract::new("owner.near".parse().unwrap(), "executor.near".parse().unwrap()); c.available = 1000; c.authorize(invoice());
        actor("executor.near"); let mut i = invoice(); i.amount = U128(43); c.reserve(i, "a".into());
    }
    #[test] #[should_panic(expected = "already reserved")] fn duplicate_attempt_rejected() {
        actor("owner.near"); let mut c = Contract::new("owner.near".parse().unwrap(), "executor.near".parse().unwrap()); c.available = 1000; c.authorize(invoice());
        actor("executor.near"); c.reserve(invoice(), "a".into()); c.reserve(invoice(), "b".into());
    }
}
