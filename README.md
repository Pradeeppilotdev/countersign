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
2. `cargo test --locked --manifest-path contract/Cargo.toml` → ten Rust unit tests pass.
3. `cargo build --locked --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release` → produces `contract/target/wasm32-unknown-unknown/release/countersign.wasm`.
4. Set `NEAR_SANDBOX_BIN_PATH="$PWD/app/sandbox-launcher/near-sandbox"` and `NEAR_SANDBOX_BINARY_PATH="$PWD/app/sandbox-launcher"`. The launcher selects the installed 2.14.0 binary and enforces local listeners and browser restrictions. Run `npm run test:sandbox` → the local integration test exercises real native NEAR transfers using sandbox balances, with separate owner, executor, attacker and merchant accounts. Expected rejection receipts appear in the output as failures; the test runner's final result determines success.


The official macOS ARM sandbox archive used here is https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Darwin-arm64/2.14.0/near-sandbox.tar.gz. Other platforms should use the corresponding official NEAR sandbox release. No mainnet/testnet credentials are required.

## Payment path

Owner calls `fund` with an attached deposit, then `authorize` with exact invoice terms. Executor calls `reserve`: the vault atomically deducts the amount from available budget and binds an attempt ID. Repeating that reservation cannot deduct again. `execute` accepts only the invoice and attempt IDs; it reads payee and amount from stored authorization, marks the invoice Executing, then issues the transfer. A private callback moves it to Settled or Failed. There is no public settlement setter, arbitrary-transfer method or executor withdrawal method.

`executor/vault.ts` connects the persistent TypeScript coordinator to that contract API through a transport bound to the executor and vault. Native reconciliation verifies the original commitment and attempt, resumes Authorized/Reserved obligations through idempotent contract calls, and reads callback settlement. Generic external rails never resubmit uncertain payments. The sandbox test exercises this adapter and checks the merchant's actual balance delta and no second payment on replay.

The vault supports **native NEAR only**, in yoctoNEAR. It does not implement USDC, cross-chain payments or 1Click. Confirmed failed native transfers return their reserved budget once and remain terminal; they cannot automatically retry. An interrupted/missing callback leaves Executing, blocking further execution. Executing payments cannot be manually released; withdrawals are not implemented.

## Security boundaries and limits

- The owner is trusted to authorize genuine obligations. Reusing the same bill under a different invoice ID is not detected. Merchant signatures and aggregate time-based spending policies are not implemented. New native authorizations expire and may be cancelled before reservation or released after a reservation expires, as described below.
- Only the designated executor can reserve/execute. It cannot change stored payment terms or invoke the private settlement callback. Reservation is not payment; the recipient receives funds only through `execute`.
- The contract account's full-access deployment key remains an administrative trust boundary. The sandbox deployer retains this key; it could upgrade the contract or transfer its balance. Neither the agent nor executor should receive it. Production key removal/governance is not implemented or claimed. The supported helper atomically deploys and privately initializes every new vault. The initializer rejects external callers even on an uninitialized deployment.
- Deposits are tracked separately from account balance. Storage and a 0.1 NEAR operating buffer are checked before executing. The deployer's initial balance covers storage in the sandbox. Storage funding/exhaustion policy needs further work.
- SQLite uniqueness spans processes sharing the same durable database. The on-chain Executing/terminal states independently prevent a second native transfer. Database recovery cannot authorize new invoice terms.
- The mock executor suite is separate from the real sandbox test. This is not an audit or proof of production safety. The development-only near-workspaces dependency tree still has low-severity elliptic advisories. Its archive dependency is pinned to patched tar 7.5.22; `npm audit --audit-level=high` currently passes. This does not constitute production security clearance.

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

Run `npm run test:restart` → a separate app is killed after reservation, restarted, and pays once. Another restart and replay preserve the same merchant balance. The test also restarts the chain process and verifies the original vault and balances. This uses an available local port and separate temporary state; no live model calls. Existing ephemeral sessions from older app versions are not migrated.

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

`npm run oneclick:approve:live` requests a fresh dry quote and verifies owner approval on a new local vault without sending funds. Live verification passed on 3 November 2026 (India time), including signature and policy checks, local owner approval, read-only recovery after reopening the records, and unchanged balances. It fails closed on outages and does not substitute archived quotes. Approval attempts are saved before the owner call; duplicates and restarts reconcile the same vault binding without submitting again. Unknown results stay unresolved, conflicting records require review, and expired approvals remain historical evidence only. Local evidence is saved at `work/live-route-approval.json`.

## Native invoice cancellation and expiry

New `authorize` calls accept an optional `expires_at` (decimal millisecond timestamp). Omit it for a one-hour expiry; explicit expiry must be in the next 24 hours. The owner cannot extend or replace an existing invoice's deadline. `invoice_expiry` reads the immutable deadline. The invoice terms commitment remains version one; the deadline is separate owner-controlled contract metadata bound to that invoice ID.

Owner-only `cancel({invoice_id})` permanently cancels an Authorized invoice or an expired Reserved invoice. An expired reservation returns its budget exactly once; the invoice ID remains used. Executing and terminal payment states cannot be cancelled. Reservation and execution independently check expiry. The agent rejects Cancelled invoices. New native failures return budget in the private callback; owner-only `release_failed` can recover budget held by confirmed failures from older code, once, without retrying the invoice.

Run `npm run test:owner:sandbox` → unauthorized cancellation, cancelled-invoice execution, ID reuse, invalid deadlines, late reservation, and late execution are rejected with exact reasons; merchant balance stays unchanged and expired reservations can be released once. Existing deployed contracts are not automatically upgraded. Legacy authorizations stored before expiry support retain no deadline; the expiry lookup returns null for them. Expiry storage uses a separate prefix and Cancelled is appended to the state enum to preserve existing stored records.

## Reproducible verification and terminal demo

From a fresh checkout, install Node 24+ and Rust with `wasm32-unknown-unknown`, run `npm ci --ignore-scripts`, and install the official NEAR Sandbox 2.14.0 executable at `work/sandbox-bin/near-sandbox`. For macOS ARM:

```sh
mkdir -p work/sandbox-bin
curl --fail --location https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Darwin-arm64/2.14.0/near-sandbox.tar.gz -o work/near-sandbox.tar.gz
tar -xzf work/near-sandbox.tar.gz -C work/sandbox-bin --strip-components=1
npm run demo:verify
```

The command builds the contract, checks agent restrictions and tampering, tests actual local payments and duplicate protection, checks owner cancellation and expiry, and kills/restarts a separate app and chain to verify recovery. An unexpected failure stops the runner with a nonzero exit code. `work/demo-output.txt` contains the full transcript; `work/demo.cast` is an asciicast v2 terminal recording playable with `asciinema play work/demo.cast`. These recordings are local artifacts and are not committed automatically.

This repeatable demo uses fixture model proposals and archived signed quote fixtures. Live AI inference was separately verified using local payment funds; fresh 1Click quote-to-approval verification also passed separately on 3 November 2026 (India time). Simulated status observations are not evidence of real cross-chain settlement. No live model key or 1Click availability is needed for `demo:verify`.

### Automated verification

Push to `main` or open a pull request → GitHub Actions builds the contract and runs the Rust unit tests, offline proposal/quote tests, local payment tests and crash recovery checks. It also rejects high/critical npm dependency advisories. The workflow uses Node 24, Rust 1.99.1 and the checksum-pinned official Linux NEAR Sandbox 2.14.0 archive. No live model key, swaps or real funds are used.

Open the workflow run → download `local-verification` for the terminal recording and transcript. Only those two files are uploaded; local chain data and keys are excluded. Low-severity upstream elliptic warnings remain visible in the audit output; the archive-library override is scoped to near-sandbox.

## Security regression checks and existing local vaults

`npm run demo:verify` also checks private atomic initialization, browser-origin RPC denial, interrupted native reservations/executions, and safe budget release. Integration files run serially to avoid the reported concurrent test-chain startup race. Local RPC rejects browser JSON preflight and browser-sendable non-JSON mutation requests; trusted local processes still have test-chain administration access.

Stop the app before upgrading an existing local vault. Build the new WASM, then run `npm run sandbox:upgrade` → the same local chain restarts with browser protection, the old code is backed up, and the new code is deployed with invoice records and available budget verified unchanged. A directory lock prevents upgrade while the app owns the vault. No chain/database reset is performed. Then `npm run dev` → use **Cancel / release expired hold** or **Release failed-transfer budget** for eligible old invoices. Existing Executing payments remain held.

1Click remains dry-run only. The desk checks NEAR/Base address formats, clears quotes after edits or failed verification, displays bounded JSON validation messages, and pins the observed optional fee recipient/rate to 1 basis point. Other unsigned fees fail closed. Raw response metadata remains untrusted even when its full hash is included in owner consent.
