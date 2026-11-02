# Countersign

Controlled agent payments on NEAR: owner approval, exact invoice checks, duplicate protection, and persistent settlement recovery.


## Local payment desk

Run `npm run dev` → open http://127.0.0.1:4317. On first launch, a fresh local vault receives 5 test NEAR; later launches reconnect to it. Enter an invoice and click **Authorize invoice as sandbox owner** → see Authorized. Click **Reserve funds** → see Reserved and the reduced available budget. Click **Execute sandbox payment** → see Settled and the merchant balance increase. Click **Test duplicate protection** → see the merchant balance stay unchanged.

The app uses `work/sandbox-bin/near-sandbox` (2.14.0) and the compiled contract at `contract/target/wasm32-unknown-unknown/release/countersign.wasm`. Its launcher restricts both chain listeners to loopback. The server holds disposable owner/executor keys; this is a local development harness. The app reconnects to the saved chain and vault on restart; state and disposable local keys stay under ignored `work/local-vault/`. The chain runs independently of the app. 1Click remains dry-run only. Run `npm run test:app` for input and initialization checks.

A local hackathon prototype that lets an executor pay an owner-approved invoice from a NEAR contract vault. The vault enforces the payee, amount, available deposit budget and one execution per invoice. It records settlement from NEAR's transfer callback, not a backend assertion.

## 1Click dry-run preview

Quote policy validation, official SDK signature verification, and persistent simulated settlement tracking are implemented in `oneclick/`. See [the 1Click guide](oneclick/README.md). Run `npm run test:oneclick` and `npm run oneclick -- demo`. This module cannot fund or submit a swap and is separate from the native NEAR vault.

## Run → observe

Prerequisites: Node 24+, Rust 1.99.1 with `wasm32-unknown-unknown`, and NEAR Sandbox **2.14.0**. The older sandbox 2.6.2 bundled by near-workspaces rejects this WASM with `PrepareError: Deserialization`; upgrading the sandbox fixed it. Cargo.lock and package-lock.json record dependencies.

From this project directory:

1. `npm ci --ignore-scripts` then `npm test` → five executor tests pass, covering persistent duplicate claims, restart, tampering, status errors and terminal failure. These use mock contract/rail adapters.
2. `cargo test --locked --manifest-path contract/Cargo.toml` → seven Rust unit tests pass.
3. `cargo build --locked --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release` → produces `contract/target/wasm32-unknown-unknown/release/countersign.wasm`.
4. Set `NEAR_SANDBOX_BIN_PATH` to the full path of the 2.14.0 `near-sandbox` binary and `NEAR_SANDBOX_BINARY_PATH` to its directory. Run `npm run test:sandbox` → the local integration test exercises real native NEAR transfers using sandbox balances, with separate owner, executor, attacker and merchant accounts. Expected rejection receipts appear in the output as failures; the test runner's final result determines success.


The official macOS ARM sandbox archive used here is https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Darwin-arm64/2.14.0/near-sandbox.tar.gz. Other platforms should use the corresponding official NEAR sandbox release. No mainnet/testnet credentials are required.

## Payment path

Owner calls `fund` with an attached deposit, then `authorize` with exact invoice terms. Executor calls `reserve`: the vault atomically deducts the amount from available budget and binds an attempt ID. Repeating that reservation cannot deduct again. `execute` accepts only the invoice and attempt IDs; it reads payee and amount from stored authorization, marks the invoice Executing, then issues the transfer. A private callback moves it to Settled or Failed. There is no public settlement setter, arbitrary-transfer method or executor withdrawal method.

`executor/vault.ts` connects the persistent TypeScript coordinator to that contract API through a transport bound to the executor and vault. Reconciliation reads contract state; it cannot declare settlement. The sandbox test exercises this adapter and checks the merchant's actual balance delta and no second payment on replay.

The vault supports **native NEAR only**, in yoctoNEAR. It does not implement USDC, cross-chain payments or 1Click. Failed transfers remain charged against the deposit budget and cannot automatically retry. An interrupted/missing callback leaves Executing, blocking further execution. Manual recovery and withdrawals are intentionally not implemented yet.

## Security boundaries and limits

- The owner is trusted to authorize genuine obligations. Reusing the same bill under a different invoice ID is not detected. Merchant signatures, expiry, revocation and aggregate time-based spending policies are not implemented.
- Only the designated executor can reserve/execute. It cannot change stored payment terms or invoke the private settlement callback. Reservation is not payment; the recipient receives funds only through `execute`.
- The contract account's full-access deployment key remains an administrative trust boundary. The sandbox deployer retains this key; it could upgrade the contract or transfer its balance. Neither the agent nor executor should receive it. Production key removal/governance is not implemented or claimed. Initialization must accompany deployment atomically in a production setup.
- Deposits are tracked separately from account balance. Storage and a 0.1 NEAR operating buffer are checked before executing. The deployer's initial balance covers storage in the sandbox. Storage funding/exhaustion policy needs further work.
- SQLite uniqueness spans processes sharing the same durable database. The on-chain Executing/terminal states independently prevent a second native transfer. Database recovery cannot authorize new invoice terms.
- The mock executor suite is separate from the real sandbox test. This is not an audit or proof of production safety. The development-only near-workspaces dependency tree has reported advisories and requires review before production tooling use.

Canonical commitment: SHA-256 of UTF-8 `NEAR-AEGIS-INVOICE-V1\n`, then invoice ID, payee, asset and positive integer amount. Each field is prefixed by its UTF-8 byte length in decimal and a colon. IDs/assets are ASCII letters, digits, `_`, `.`, `:`, `-`, length 1–128. Amounts use canonical decimal unsigned 128-bit base units. The contract authorizes only asset `near`.

## Hackathon and next work

`HACKATHON.md` preserves the user's supplied rules. Re-read https://nearhackathon.com/HACKATHON.md before submission. This is new AI-assisted code using NEAR SDK, near-workspaces and Node SQLite. Final tracks and license remain team decisions. Publishing, live spending and submission still require explicit confirmation.

Next: design 1Click quote authentication and bind deposit, final recipient and refund terms to approval before adding any live funding. Preserve uncertain-outcome holds. Relevant official references: https://docs.near.org/smart-contracts/testing/integration-test and https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api.

## Restricted agent payment capability

`agent/payment-tool.ts` exposes `request_payment({invoice_id})` for one host-assigned invoice. The trusted host pins the vault transport, invoice terms and persistent attempt database. The model cannot provide payment destinations, amounts, keys or arbitrary methods. `runInvoiceAgent` accepts one proposal from an injected proposer; the NEAR AI adapter has been verified with a live provider call using local test funds. This is not an OS sandbox for arbitrary code.

Run `npm run test:agent` → malformed proposals and extra payment fields are rejected before any transaction. Run `npm run test:agent:sandbox` → a real local vault transfer succeeds, its response is deliberately lost, and a new executor instance reopens the same records against the same running vault. Concurrent repeated requests reconcile to settled with exactly one submission and one merchant credit. This tests executor recovery, not restarting the entire chain or app server. No model API calls, real funds or 1Click execution are involved.

## Agent runner (no UI needed)

Run `npm run agent:demo` → a labelled fixture model response passes through the proposal parser and restricted payment tool into a fresh local vault; the merchant receives 0.1 test NEAR exactly once. A repeated request returns settled without another transfer. The test chain closes afterward and attempt records stay in ignored `work/`.

The optional live adapter follows the [NEAR AI Chat Completions API](https://docs.near.ai/api-reference/chat/create-chat-completion). It uses one bounded request, accepts one complete tool call, rejects changed terms and extra arguments, and does not retry provider failures. Only the four structured invoice fields are sent; wallet keys and invoice attachments are excluded. No attestation verification is implemented or claimed.

To opt into a potentially billable model request, configure `NEAR_AI_API_KEY` and `NEAR_AI_MODEL` in your local environment, then run `npm run agent:demo -- --live-model`. Select a model supporting function calls. That command sends the synthetic test invoice to NEAR AI but still pays exclusively on a new local sandbox chain. Default mode never reads a model key or calls the model service. Keep credentials out of source control. Model availability and compatibility can change; malformed, refused or truncated responses stop before payment.

## App restart recovery

Run `npm run dev` → the app opens the saved local vault, or creates one on first use. Invoice terms and attempt IDs are persisted before authorization. Existing attempts are reconciled against the contract at startup without resubmitting. A directory lock prevents two app processes from managing the same records. An incomplete setup fails closed rather than funding a replacement vault. The local chain keeps running after the app exits and uses its saved database if restarted.

Run `npm run test:restart` → a separate app is killed after reservation, restarted, and pays once. Another restart and replay preserve the same merchant balance. The test also restarts the chain process and verifies the original vault and balances. This uses port 4328 and separate temporary state; no live model calls. Existing ephemeral sessions from older app versions are not migrated.

## Owner approval of a dry 1Click route

`DryRunWorkflow.approve(id, ownerTransport)` revalidates a saved LIVE_PREVIEW, then calls the contract's owner-only `authorize_route`. Archived or expired quotes cannot be approved through this path. `oneclick/approval.ts` binds the vault account, invoice ID, both assets, final recipient, refund address, exact output, input cap, quoted input, expiry, provider quote hash and canonical full-response hash. The contract's `check_route` rejects changed or expired terms; repeat approvals of identical unexpired terms are idempotent. The owner-side code verifies the provider signature; the contract records owner consent and does not verify the provider signature itself.

Run `npm run test:oneclick` → quote tampering, expiry and commitment coverage checks pass. Run `npm run test:route:sandbox` → local contract checks reject non-owner approval, modified fields, expired approval and attempts to execute a route as a native payment; balances remain unchanged. This test uses an authenticated archived quote with a synthetic fresh expiry solely to test contract rules, not to claim a fresh live approval.

Approvals remain DRY_RUN and non-fundable: there is no deposit address, swap submission or route-payment method. A future executable quote needs a separate approval format that binds its actual deposit routing; a dry approval cannot be promoted into spend authority. Existing deployed local contracts are not automatically upgraded; these tests deploy the updated WASM to fresh local accounts. Storage for route approvals uses a new prefix without changing the native contract state layout. Expired route IDs cannot be rebound to a different quote.

## Contract build and rejection diagnostics

Build from the project root so `.cargo/config.toml` applies `--cfg near` for the WASM target. The installed SDK requires this flag to route environment operations through NEAR host functions. Without it, rejected calls can appear as generic `unreachable` traps. The contract now uses explicit NEAR rejection messages, and the route integration test requires the expected reason rather than treating any error as success.

`npm run test:route:sandbox` prints `PASS: rejected ...` for each intentional rejection. The SDK may also print the corresponding failed receipt; its reason must match the assertion. Unexpected failures still fail the test. Fresh test vaults use the rebuilt WASM; existing deployed vaults are not silently upgraded.

## Project naming and local configuration

The project is Countersign. Version-one cryptographic domain strings retain `NEAR-AEGIS-*` to preserve existing invoice and route commitments; these are protocol identifiers, not current branding. Use `COUNTERSIGN_PORT` and `COUNTERSIGN_SANDBOX_DIR` to override local settings (legacy `AEGIS_*` variables remain compatible).

The sandbox binary must be installed at `work/sandbox-bin/near-sandbox` before running the app, demos or tests. For macOS ARM, download the official archive linked above and extract its `near-sandbox` executable there. Dependencies, binaries, `.env`, disposable local keys, chain databases and generated screenshots are not part of this repository.

`npm run oneclick:approve:live` requests a fresh dry quote and verifies owner approval on a new local vault without sending funds. This check currently reports HTTP 521 from the provider; offline quote tests and local route approval tests pass. It fails closed and does not substitute archived quotes.
