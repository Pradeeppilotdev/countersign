use super::*;
use merchant_auth::SignedInvoice;

const WEEK_MS: u64 = 7 * 24 * 60 * 60 * 1000;

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ServicePeriod {
    pub agreement_id: String,
    pub period_start_ms: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, PartialEq, Eq)]
pub struct WeeklyService {
    pub merchant_id: String,
    pub payee: AccountId,
    pub anchor_ms: U64,
    pub cap: U128,
    pub revoked: bool,
}

// Separate prefixes keep existing vaults and V1 invoice receipts upgradeable.
fn agreements() -> LookupMap<String, WeeklyService> {
    LookupMap::new(b"weekly-agreements-v1".to_vec())
}
fn protected_merchants() -> LookupMap<String, bool> {
    LookupMap::new(b"weekly-merchants-v1".to_vec())
}
fn protected_payees() -> LookupMap<AccountId, bool> {
    LookupMap::new(b"weekly-payees-v1".to_vec())
}
fn claims() -> LookupMap<ServicePeriod, String> {
    LookupMap::new(b"weekly-claims-v1".to_vec())
}
fn invoice_periods() -> LookupMap<String, ServicePeriod> {
    LookupMap::new(b"weekly-invoice-periods-v1".to_vec())
}
// Each original has at most one successor. The digest binds the full signed
// replacement so an exact retry can recover after expiry or key rotation.
fn corrections() -> LookupMap<String, (String, [u8; 32])> {
    LookupMap::new(b"weekly-corrections-v1".to_vec())
}

fn current_start(anchor: u64, now: u64) -> Option<u64> {
    let elapsed = now.checked_sub(anchor)?;
    Some(now - elapsed % WEEK_MS)
}

pub(super) fn require_unprotected(invoice: &Invoice, merchant_id: &String) {
    near_sdk::require!(!protected_merchants().contains_key(merchant_id), "signed service period required");
    require_manual_payee(&invoice.payee);
}

pub(super) fn require_manual_payee(payee: &AccountId) {
    near_sdk::require!(!protected_payees().contains_key(payee), "signed service period required");
}

pub(super) fn authorization_expiry(signed: &SignedInvoice) -> U64 {
    let Some(period) = &signed.service else {
        require_unprotected(&signed.invoice, &signed.merchant_id);
        return signed.expires_at;
    };
    let agreement = agreements().get(&period.agreement_id)
        .unwrap_or_else(|| env::panic_str("unknown service agreement"));
    near_sdk::require!(agreement.merchant_id == signed.merchant_id && agreement.payee == signed.invoice.payee, "service merchant or payout mismatch");
    near_sdk::require!(!agreement.revoked, "service agreement revoked");
    near_sdk::require!(signed.invoice.amount.0 <= agreement.cap.0, "service payment cap exceeded");
    let start = period.period_start_ms.0;
    near_sdk::require!(current_start(agreement.anchor_ms.0, env::block_timestamp_ms()) == Some(start), "outside current service period");
    if let Some(winner) = claims().get(period) {
        if winner != signed.invoice.id {
            env::panic_str(&format!("service period already claimed by [{winner}]"));
        }
    }
    U64(signed.expires_at.0.min(start.saturating_add(WEEK_MS)))
}

// Called in the same receipt as policy authorization. No external promises or
// cleanup paths touch a claim. Only an explicit owner correction can move it.
pub(super) fn record(invoice_id: &String, period: &ServicePeriod) {
    claims().insert(period, invoice_id);
    invoice_periods().insert(invoice_id, period);
}

pub(super) fn check_bound(invoice: &Invoice, merchant_id: &String) {
    if let Some(period) = invoice_periods().get(&invoice.id) {
        let agreement = agreements().get(&period.agreement_id)
            .unwrap_or_else(|| env::panic_str("unknown service agreement"));
        near_sdk::require!(!agreement.revoked, "service agreement revoked");
        near_sdk::require!(claims().get(&period).as_ref() == Some(&invoice.id), "service claim mismatch");
        // The immutable period end is enforced by the stored invoice expiry.
    } else {
        require_unprotected(invoice, merchant_id);
    }
}

#[near]
impl Contract {
    pub fn add_weekly_service(&mut self, agreement_id: String, merchant_id: String, anchor_ms: U64, cap: U128) -> WeeklyService {
        near_sdk::require!(env::predecessor_account_id() == self.owner, "owner only");
        near_sdk::require!(valid_id(&agreement_id), "invalid service agreement id");
        let policy = self.get_policy().unwrap_or_else(|| env::panic_str("no spending policy"));
        near_sdk::require!(env::block_timestamp_ms() < policy.expires_at.0, "policy expired");
        let merchant = policy.merchants.iter().find(|m| m.id == merchant_id)
            .unwrap_or_else(|| env::panic_str("merchant not allowed"));
        near_sdk::require!(self.get_merchant_key(merchant_id.clone()).is_some_and(|key| key.public_key.is_some()), "active merchant key required");
        near_sdk::require!(cap.0 > 0 && cap.0 <= policy.per_payment.0, "invalid service payment cap");
        let agreement = WeeklyService { merchant_id, payee: merchant.payee.clone(), anchor_ms, cap, revoked: false };
        if let Some(existing) = agreements().get(&agreement_id) {
            near_sdk::require!(existing == agreement, "service agreement already bound");
            return existing;
        }
        agreements().insert(&agreement_id, &agreement);
        protected_merchants().insert(&agreement.merchant_id, &true);
        protected_payees().insert(&agreement.payee, &true);
        agreement
    }

    pub fn revoke_weekly_service(&mut self, agreement_id: String) -> WeeklyService {
        near_sdk::require!(env::predecessor_account_id() == self.owner, "owner only");
        let mut agreement = agreements().get(&agreement_id)
            .unwrap_or_else(|| env::panic_str("unknown service agreement"));
        agreement.revoked = true;
        agreements().insert(&agreement_id, &agreement);
        agreement
    }

    pub fn get_weekly_service(&self, agreement_id: String) -> Option<WeeklyService> {
        agreements().get(&agreement_id)
    }

    pub fn current_service_period(&self, agreement_id: String) -> Option<ServicePeriod> {
        let agreement = agreements().get(&agreement_id)?;
        if agreement.revoked { return None; }
        let start = current_start(agreement.anchor_ms.0, env::block_timestamp_ms())?;
        Some(ServicePeriod { agreement_id, period_start_ms: U64(start) })
    }

    pub fn get_service_claim(&self, service: ServicePeriod) -> Option<String> {
        claims().get(&service)
    }

    pub fn get_weekly_correction(&self, original_id: String) -> Option<String> {
        corrections().get(&original_id).map(|(successor, _)| successor)
    }

    pub fn correct_weekly_invoice(
        &mut self, original_id: String, original_payload_hash: String, replacement: SignedInvoice,
    ) -> Payment {
        near_sdk::require!(env::predecessor_account_id() == self.owner, "owner only");
        let auth = self.get_invoice_auth(original_id.clone())
            .unwrap_or_else(|| env::panic_str("original signed bill not found"));
        near_sdk::require!(auth.payload_hash == original_payload_hash, "original signed bill mismatch");
        let next_id = replacement.invoice.id.clone();
        let digest = merchant_auth::signed_envelope_hash(&replacement);
        if let Some((successor, previous_digest)) = corrections().get(&original_id) {
            near_sdk::require!(successor == next_id && digest == previous_digest, "correction already bound");
            return self.payments.get(&successor).expect("missing corrected payment");
        }

        controls::require_running();
        let original = self.payments.get(&original_id).expect("missing original payment");
        near_sdk::require!(original.attempt_id.is_none()
            && matches!(original.state, State::Authorized | State::Cancelled),
            "correction requires a never-reserved bill");
        let period = invoice_periods().get(&original_id)
            .unwrap_or_else(|| env::panic_str("original is not a weekly bill"));
        near_sdk::require!(claims().get(&period).as_ref() == Some(&original_id), "service claim mismatch");
        near_sdk::require!(replacement.service.as_ref() == Some(&period)
            && replacement.merchant_id == auth.merchant_id && replacement.invoice.payee == original.invoice.payee
            && replacement.invoice.asset == original.invoice.asset, "correction changes the service or payee");
        near_sdk::require!(replacement.invoice.amount.0 <= original.invoice.amount.0, "correction increases amount");
        near_sdk::require!(self.payments.get(&next_id).is_none(), "replacement invoice id already used");

        // One synchronous receipt. If signature, current policy or bill checks
        // fail, NEAR rolls back the cancellation, its quota release and the claim.
        self.cancel(original_id.clone());
        claims().insert(&period, &next_id);
        let payment = self.apply_signed_invoice(replacement);
        corrections().insert(&original_id, &(next_id, digest));
        payment
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env, PromiseResult, VMContext};

    fn context(actor: &str, now: u64) -> VMContext {
        VMContextBuilder::new()
            .current_account_id("vault.near".parse().unwrap())
            .predecessor_account_id(actor.parse().unwrap())
            .block_timestamp(now * 1_000_000)
            .build()
    }

    fn authorized_period() -> (Contract, SignedInvoice) {
        use near_sdk::serde_json::{from_value, json};
        testing_env!(context("owner.near", 1000));
        let mut vault = Contract::new("owner.near".parse().unwrap(), "executor.near".parse().unwrap());
        vault.available = 100;
        let merchant = policy::Merchant { id: "supplier".into(), payee: "merchant.near".parse().unwrap() };
        vault.set_policy(vec![merchant], U128(100), U128(150), U64(7_200_000), None);
        vault.configure_invoice_auth("a".repeat(64));
        // Public V2 interoperability vector signed by merchant/invoice.ts.
        let public_key = from_value(json!("B74XhyDVcoo0KFjTyU+tmZwkHNJHjzm9NMNT7+wy9nk=")).unwrap();
        vault.set_merchant_key("supplier".into(), Some(public_key));
        vault.add_weekly_service("compute".into(), "supplier".into(), U64(0), U128(100));
        let signed: SignedInvoice = from_value(json!({
            "invoice": {"id":"claimed-week","payee":"merchant.near","asset":"near","amount":"40"},
            "merchant_id":"supplier","bill_id":"bill","vault":"vault.near","domain":"a".repeat(64),
            "key_version":"1","expires_at":"3600000","service":{"agreement_id":"compute","period_start_ms":"0"},
            "signature":"/X8VxqSv2PPnRLpAf5OuFpnREKBwAX+FqSP0NVzJV5bvNXbnTQwMFpKKEBns4dDTKFiN2yEqVw/wVrHTnePtCg=="
        })).unwrap();
        testing_env!(context("executor.near", 1000));
        vault.authorize_signed_invoice(signed.clone());
        (vault, signed)
    }

    #[test]
    fn cancelling_an_unspent_approval_releases_budget_and_preserves_its_week() {
        let (mut vault, signed) = authorized_period();
        vault.authorize_signed_invoice(signed.clone());
        assert_eq!(vault.policy_usage().0, 40);
        testing_env!(context("owner.near", 2000));
        vault.cancel(signed.invoice.id.clone());
        assert_eq!(vault.available, 100);
        assert_eq!(vault.policy_usage().0, 0);
        assert_eq!(vault.get_service_claim(signed.service.unwrap()), Some(signed.invoice.id));
    }

    #[test]
    #[should_panic(expected = "correction requires a never-reserved bill")]
    fn cancelling_an_expired_reservation_does_not_make_it_correctable() {
        let (mut vault, signed) = authorized_period();
        let id = signed.invoice.id.clone();
        let hash = vault.get_invoice_auth(id.clone()).unwrap().payload_hash;
        vault.reserve(signed.invoice.clone(), "reserved".into());
        testing_env!(context("owner.near", signed.expires_at.0));
        let cancelled = vault.cancel(id.clone());
        assert_eq!(cancelled.state, State::Cancelled);
        assert_eq!(cancelled.attempt_id.as_deref(), Some("reserved"));
        vault.correct_weekly_invoice(id, hash, signed);
    }

    #[test]
    fn uncertain_dispatch_keeps_the_week_and_budget_through_renewal_until_its_callback() {
        let (mut vault, signed) = authorized_period();
        let id = signed.invoice.id.clone();
        let period = signed.service.unwrap();
        vault.reserve(signed.invoice, "attempt".into());
        drop(vault.execute(id.clone(), "attempt".into()));
        assert_eq!(vault.get_payment(id.clone()).unwrap().state, State::Executing);

        let next_week = WEEK_MS + 1;
        testing_env!(context("owner.near", next_week));
        vault.renew_policy("renew".into(), U64(1), U64(next_week + 3_600_000));
        assert_eq!(vault.policy_usage().0, 40);
        assert_eq!(vault.available, 60);
        assert_eq!(vault.get_service_claim(period.clone()), Some(id.clone()));

        #[allow(deprecated)]
        near_sdk::test_utils::testing_env_with_promise_results(context("vault.near", next_week), PromiseResult::Failed);
        assert_eq!(vault.on_transfer(id.clone(), "attempt".into()).state, State::Failed);
        assert_eq!(vault.available, 100);
        assert_eq!(vault.policy_usage().0, 0);
        assert_eq!(vault.get_service_claim(period), Some(id));
    }

    #[test]
    fn service_weeks_are_half_open_and_never_start_before_the_anchor() {
        let anchor = 300_000;
        assert_eq!(current_start(anchor, anchor - 1), None);
        assert_eq!(current_start(anchor, anchor), Some(anchor));
        assert_eq!(current_start(anchor, anchor + WEEK_MS - 1), Some(anchor));
        assert_eq!(current_start(anchor, anchor + WEEK_MS), Some(anchor + WEEK_MS));
        assert_eq!(current_start(anchor, anchor + 20 * WEEK_MS + 9), Some(anchor + 20 * WEEK_MS));
    }
}
