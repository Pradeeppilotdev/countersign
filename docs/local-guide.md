# Countersign local setup and reference

See the [weekly payment attack results](attack-results/README.md) for the recorded balances and crash checkpoint.

## Quick start

From a fresh clone to a working demo. Run every command from the repository root. **Windows:** use WSL2 and follow the Linux steps.

### 1. Prerequisites

- **Node 24+**: install from https://nodejs.org/en/download, then check `node --version`.
- **macOS only**: Xcode Command Line Tools, Homebrew and `xz`:
  ```sh
  xcode-select --install
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  brew install xz
  ```
  Run the "Next steps" Homebrew prints so `brew` is on your PATH. `xz` is required: the macOS near-sandbox binary loads Homebrew's `liblzma.5.dylib` at runtime. Without it, every sandbox test fails with `dyld: Library not loaded: …/liblzma.5.dylib`. The Linux binary does not need it.
- **Rust 1.99.1** with the WASM target:
  ```sh
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.99.1
  source "$HOME/.cargo/env"
  rustup target add wasm32-unknown-unknown
  ```

### 2. Set up

1. Install dependencies and build the contract:
   ```sh
   npm ci --ignore-scripts
   cargo build --locked --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release
   ```
2. Install NEAR Sandbox 2.14.0. Set `PLATFORM` to `Darwin-arm64` (Apple Silicon), `Darwin-x86_64` (Intel Mac) or `Linux-x86_64`:
   ```sh
   PLATFORM=Darwin-arm64
   mkdir -p work/sandbox-bin
   curl --fail --location "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/$PLATFORM/2.14.0/near-sandbox.tar.gz" -o work/near-sandbox.tar.gz
   tar -xzf work/near-sandbox.tar.gz -C work/sandbox-bin --strip-components=1
   chmod +x work/sandbox-bin/near-sandbox
   work/sandbox-bin/near-sandbox --version   # neard (release 2.14.0) …
   ```
   Optional: check the archive with `shasum -a 256 work/near-sandbox.tar.gz` (Linux: `sha256sum`):

   | Platform | SHA-256 of `near-sandbox.tar.gz` |
   |---|---|
   | Darwin-arm64 | `ea53448ef97540c012e5c3d967c74d78292b0465a98cf7027811a936718fe232` |
   | Darwin-x86_64 | `b67b7bd48f18dc4dec96ca91332788670fd2e6b42a999323dfa7f62beb21ee69` |
   | Linux-x86_64 | `a0ba004218b218bd74351795e7ce2eda4a2b6af5cd3e252bd5e8bfe3c8f2e691` |
3. Point the sandbox tests at the loopback-only launcher (repeat in each new shell):
   ```sh
   export NEAR_SANDBOX_BIN_PATH="$PWD/app/sandbox-launcher/near-sandbox" NEAR_SANDBOX_BINARY_PATH="$PWD/app/sandbox-launcher"
   ```
   The launcher uses the installed 2.14.0 binary and rewrites RPC/P2P listeners to `127.0.0.1`; pointing tests directly at the binary bypasses that protection. Without these, `npm run test:sandbox` falls back to the sandbox 2.6.2 bundled with near-workspaces, which rejects this contract with `PrepareError: Deserialization`. `npm run demo:verify` and `npm run dev` don't need them.

### 3. Verify

```sh
npm run demo:verify
```

Recent full runs took about 15–20 minutes on a warm toolchain (longer on a fresh build) and ends with `ALL CHECKS PASSED. No live model calls, swaps or real funds.` The transcript is saved to `work/demo-output.txt`. The recording is saved to `work/demo.cast`; replaying it needs asciinema (`brew install asciinema`, then `asciinema play work/demo.cast`).

### 4. Run the payment desk

```sh
npm run dev
```

Open http://127.0.0.1:4317 → see [Agent payments](#agent-payments-in-the-desk). The manual payment desk and 1Click lab are under **Tools**.

- Use `127.0.0.1`, not `localhost`: `localhost` returns 403.
- If port 4317 is busy, run `COUNTERSIGN_PORT=4418 npm run dev` and open http://127.0.0.1:4418.
- Ctrl-C stops the app, but the local chain keeps running so the next launch reconnects to your vault. To stop the chain:
  ```sh
  kill "$(node -p "require('./work/local-vault/chain.json').pid")"
  ```
- To reset to a fresh vault, stop the chain, then run `rm -rf work/local-vault work/app.db`.

## Local payment desk

Run `npm run dev` → open http://127.0.0.1:4317/#payments, or choose **Tools → Manual payment desk**. On first launch, a fresh local vault receives 5 test NEAR; later launches reconnect to it. Enter an invoice and click **Authorize invoice** → see its approval. Reserve and pay from the invoice list → see Paid and the merchant balance increase. Test duplicate protection → see the merchant balance stay unchanged.

The app uses `work/sandbox-bin/near-sandbox` (2.14.0) and the compiled contract at `contract/target/wasm32-unknown-unknown/release/countersign.wasm`. Its launcher restricts both chain listeners to loopback. The server holds disposable owner/executor keys; this is a local development harness. The app reconnects to the saved chain and vault on restart; state and disposable local keys stay under ignored `work/local-vault/`. The chain runs independently of the app. 1Click remains dry-run only. Run `npm run test:app` for input and initialization checks.

A local hackathon prototype that lets an executor pay an owner-approved invoice from a NEAR contract vault. The vault enforces the payee, amount, available deposit budget and one execution per invoice. It records settlement from NEAR's transfer callback, not a backend assertion.

## 1Click dry-run preview

Quote policy validation, official SDK signature verification, and persistent simulated settlement tracking are implemented in `oneclick/`. See [the 1Click guide](../oneclick/README.md). Run `npm run test:oneclick` and `npm run oneclick -- demo`. This module cannot fund or submit a swap and is separate from the native NEAR vault.

## Run → observe

Prerequisites: Node 24+, Rust 1.99.1 with `wasm32-unknown-unknown`, and NEAR Sandbox **2.14.0**. The older sandbox 2.6.2 bundled by near-workspaces rejects this WASM with `PrepareError: Deserialization`; upgrading the sandbox fixed it. Cargo.lock and package-lock.json record dependencies.

From this project directory:

1. `npm ci --ignore-scripts` then `npm test` → seven executor tests pass, covering persistent duplicate claims, restart, tampering, status errors and terminal failure. These use mock contract/rail adapters.
2. `cargo test --locked --manifest-path contract/Cargo.toml` → the vault’s authorization, accounting and service-period unit tests pass.
3. `cargo build --locked --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release` → produces `contract/target/wasm32-unknown-unknown/release/countersign.wasm`.
4. Set `NEAR_SANDBOX_BIN_PATH="$PWD/app/sandbox-launcher/near-sandbox"` and `NEAR_SANDBOX_BINARY_PATH="$PWD/app/sandbox-launcher"`. The launcher selects the installed 2.14.0 binary and enforces local listeners and browser restrictions. Run `npm run test:sandbox` → the local integration test exercises real native NEAR transfers using sandbox balances, with separate owner, executor, attacker and merchant accounts. Expected rejection receipts appear in the output as failures; the test runner's final result determines success.


The official macOS ARM sandbox archive used here is https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Darwin-arm64/2.14.0/near-sandbox.tar.gz. Intel Mac and Linux x86_64 archives, with checksums, are listed in [Quick start](#quick-start). No mainnet/testnet credentials are required.

## Payment path

Owner calls `fund` with an attached deposit, then `authorize` with exact invoice terms. Executor calls `reserve`: the vault atomically deducts the amount from available budget and binds an attempt ID. Repeating that reservation cannot deduct again. `execute` accepts only the invoice and attempt IDs; it reads payee and amount from stored authorization, marks the invoice Executing, then issues the transfer. A private callback moves it to Settled or Failed. There is no public settlement setter, arbitrary-transfer method or executor withdrawal method.

`executor/vault.ts` connects the persistent TypeScript coordinator to that contract API through a transport bound to the executor and vault. Native reconciliation verifies the original commitment and attempt, resumes Authorized/Reserved obligations through idempotent contract calls, and reads callback settlement. Generic external rails never resubmit uncertain payments. The sandbox test exercises this adapter and checks the merchant's actual balance delta and no second payment on replay.

The vault supports **native NEAR only**, in yoctoNEAR. It does not implement USDC, cross-chain payments or 1Click. Confirmed failed native transfers return their reserved budget once and remain terminal; they cannot automatically retry. An interrupted/missing callback leaves Executing, blocking further execution. Executing payments cannot be manually released; withdrawals are not implemented.

## Security boundaries and limits

- The owner is trusted to authorize genuine obligations. Optional merchant signatures authenticate invoice bytes under an owner-pinned key. Signed merchant bill IDs cannot be paid under a second invoice ID; for an enrolled weekly service, a second bill ID for the same period is also rejected. A signature does not prove that a bill is legitimate. Optional owner-set spending policies constrain executor-approved native invoices as described below. New native authorizations expire and may be cancelled before reservation or released after a reservation expires, as described below.
- Only the designated executor can reserve/execute. It cannot change stored payment terms or invoke the private settlement callback. Reservation is not payment; the recipient receives funds only through `execute`.
- The contract account's full-access deployment key remains an administrative trust boundary. The sandbox deployer retains this key; it could upgrade the contract or transfer its balance. Neither the agent nor executor should receive it. Production key removal/governance is not implemented or claimed. The supported helper atomically deploys and privately initializes every new vault. The initializer rejects external callers even on an uninitialized deployment.
- Deposits are tracked separately from account balance. Storage and a 0.1 NEAR operating buffer are checked before executing. The deployer's initial balance covers storage in the sandbox. Storage funding/exhaustion policy needs further work.
- SQLite uniqueness spans processes sharing the same durable database. The on-chain Executing/terminal states independently prevent a second native transfer. For an already authorized invoice, recovery must match the on-chain commitment. Before authorization, unsigned invoice terms are trusted host data: a writer to SQLite who changes both the invoice and its hash can request different terms within the policy. Use owner-pinned merchant signatures for agent-paid merchants; the contract rejects changed signed terms or stripping the signature. The local host also holds development keys, so database permissions alone are not a custody boundary.
- The mock executor suite is separate from the real sandbox test. This is not an audit or proof of production safety. The development-only near-workspaces dependency tree still has low-severity elliptic advisories. Its archive dependency is pinned to patched tar 7.5.22; `npm audit --audit-level=high` currently passes. This does not constitute production security clearance.

Canonical commitment: SHA-256 of UTF-8 `NEAR-AEGIS-INVOICE-V1\n`, then invoice ID, payee, asset and positive integer amount. Each field is prefixed by its UTF-8 byte length in decimal and a colon. IDs/assets are ASCII letters, digits, `_`, `.`, `:`, `-`, length 1–128. Amounts use canonical decimal unsigned 128-bit base units. The contract authorizes only asset `near`.

## Restricted agent payment capability

`agent/payment-tool.ts` exposes `request_payment({invoice_id})` for one host-assigned invoice. The trusted host pins the vault transport, invoice terms and persistent attempt database. The model cannot provide payment destinations, amounts, keys or arbitrary methods. `runInvoiceAgent` accepts one proposal from an injected proposer; the NEAR AI adapter has been verified with a live provider call using local test funds. This is not an OS sandbox for arbitrary code.

Run `npm run test:agent` → malformed proposals and extra payment fields are rejected before any transaction. Run `npm run test:agent:sandbox` → a real local vault transfer succeeds, its response is deliberately lost, and a new executor instance reopens the same records against the same running vault. Concurrent repeated requests reconcile to settled with exactly one submission and one merchant credit. This tests executor recovery, not restarting the entire chain or app server. No model API calls, real funds or 1Click execution are involved.

## Agent runner (no UI needed)

Run `npm run agent:demo` → a labelled fixture model response passes through the proposal parser and restricted payment tool into a fresh local vault; the merchant receives 0.1 test NEAR exactly once. A repeated request returns settled without another transfer. The test chain closes afterward and attempt records stay in ignored `work/`.

The optional live adapter follows the [NEAR AI Chat Completions API](https://docs.near.ai/api-reference/chat/create-chat-completion). It uses one bounded request, accepts one complete tool call, rejects changed terms and extra arguments, and does not retry provider failures. Only the four structured invoice fields are sent; wallet keys and invoice attachments are excluded. No attestation verification is implemented or claimed.

To opt into a potentially billable model request, configure `NEAR_AI_API_KEY` and `NEAR_AI_MODEL` in your local environment or ignored project `.env`, then run `npm run agent:demo -- --live-model`. Select a model supporting function calls. That command sends the synthetic test invoice to NEAR AI but still pays exclusively on a new local sandbox chain. Only `--live-model` reads the two inference settings from `.env` (environment values take precedence); file credentials are not exported into child-chain environments. Default mode never reads a model key or calls the model service. Keep credentials out of source control. Model availability and compatibility can change; malformed, refused or truncated responses stop before payment.

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

The sandbox binary must be installed at `work/sandbox-bin/near-sandbox` before running the app, demos or tests. Follow [Quick start](#quick-start) step 2 for your platform. Dependencies, binaries, `.env`, disposable local keys, chain databases and generated screenshots are not part of this repository.

`npm run oneclick:approve:live` requests a fresh dry quote and verifies owner approval on a new local vault without sending funds. Live verification passed on 3 November 2026 (India time), including signature and policy checks, local owner approval, read-only recovery after reopening the records, and unchanged balances. It fails closed on outages and does not substitute archived quotes. Approval attempts are saved before the owner call; duplicates and restarts reconcile the same vault binding without submitting again. Unknown results stay unresolved, conflicting records require review, and expired approvals remain historical evidence only. Local evidence is saved at `work/live-route-approval.json`.

## Native invoice cancellation and expiry

New `authorize` calls accept an optional `expires_at` (decimal millisecond timestamp). Omit it for a one-hour expiry; explicit expiry must be in the next 24 hours. The owner cannot extend or replace an existing invoice's deadline. `invoice_expiry` reads the immutable deadline. The invoice terms commitment remains version one; the deadline is separate owner-controlled contract metadata bound to that invoice ID.

Owner-only `cancel({invoice_id})` permanently cancels an Authorized invoice or an expired Reserved invoice; a Reserved policy invoice is also eligible after its policy has been revoked or replaced. An expired reservation returns its budget exactly once; the invoice ID remains used. Executing and terminal payment states cannot be cancelled. Reservation and execution independently check expiry. The agent reports Cancelled invoices as terminal without submitting payment. New native failures return budget in the private callback; owner-only `release_failed` can recover budget held by confirmed failures from older code, once, without retrying the invoice.

For an imported signed bill, `npm run agent:desk -- cancel INVOICE_ID` also works **before authorization**, including while the model is thinking or the vault is paused. The owner submits the exact signed bill to `cancel_signed_invoice`; the contract retains its invoice ID, merchant bill ID and signature receipt as permanently cancelled. It neither charges nor releases allowance and does not claim a service week, so a different genuine bill for that week can still be considered. A late proposal cannot reopen the cancelled bill. If authorization or reservation wins the race, the existing cancellation rules apply. A never-recorded bill needs the currently pinned merchant key; an already-recorded bill uses its retained receipt even after expiry or key revocation.

`npm run test:cancel:queued` → kill the owner process after cancellation, deliver a late model response, and retry: the cancelled bill pays **0.00**. Reverse the ordering so reservation wins → cancellation keeps the hold, and payment crash/retry pays **0.04 local test NEAR once**. The test also rejects tampering, signed-bill collisions and executor cancellation. Saved vaults need the explicit state-preserving code upgrade described below for cancellation before authorization; this command never upgrades or resets them automatically.

Run `npm run test:owner:sandbox` → unauthorized cancellation, cancelled-invoice execution, ID reuse, invalid deadlines, late reservation, and late execution are rejected with exact reasons; merchant balance stays unchanged and expired reservations can be released once. Existing deployed contracts are not automatically upgraded. Legacy authorizations stored before expiry support retain no deadline; the expiry lookup returns null for them. Expiry storage uses a separate prefix and Cancelled is appended to the state enum to preserve existing stored records.

## Reproducible verification and terminal demo

From a fresh checkout, install Node 24+ and Rust with `wasm32-unknown-unknown`, run `npm ci --ignore-scripts`, and install the official NEAR Sandbox 2.14.0 executable at `work/sandbox-bin/near-sandbox`. For macOS ARM:

```sh
mkdir -p work/sandbox-bin
curl --fail --location https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Darwin-arm64/2.14.0/near-sandbox.tar.gz -o work/near-sandbox.tar.gz
tar -xzf work/near-sandbox.tar.gz -C work/sandbox-bin --strip-components=1
npm run demo:verify
```

The command builds the contract, checks agent restrictions and tampering, tests actual local payments and duplicate protection, checks owner cancellation and expiry, and kills/restarts a separate app and chain to verify recovery. An unexpected failure stops the runner with a nonzero exit code. On macOS, the runner temporarily prevents idle system sleep for the duration of verification; display and persistent power settings are unchanged. `work/demo-output.txt` contains the full transcript; `work/demo.cast` is an asciicast v2 terminal recording playable with `asciinema play work/demo.cast`. These recordings are local artifacts and are not committed automatically.

This repeatable demo uses fixture model proposals and archived signed quote fixtures. Live AI inference was separately verified using local payment funds; fresh 1Click quote-to-approval verification also passed separately on 3 November 2026 (India time). Simulated status observations are not evidence of real cross-chain settlement. No live model key or 1Click availability is needed for `demo:verify`.

### Automated verification

Push to `main` or open a pull request → GitHub Actions builds the contract and runs the Rust unit tests, offline proposal/quote tests, local payment tests and crash recovery checks. It also rejects high/critical npm dependency advisories. The workflow uses Node 24, Rust 1.99.1 and the checksum-pinned official Linux NEAR Sandbox 2.14.0 archive. No live model key, swaps or real funds are used.

Open the workflow run → download `local-verification` for the terminal recording and transcript. Only those two files are uploaded; local chain data and keys are excluded. Low-severity upstream elliptic warnings remain visible in the audit output; the archive-library override is scoped to near-sandbox.

## Security regression checks and existing local vaults

`npm run demo:verify` also checks private atomic initialization, browser-origin RPC denial, interrupted native reservations/executions, and safe budget release. Integration files run serially to avoid the reported concurrent test-chain startup race. Local RPC rejects browser JSON preflight and browser-sendable non-JSON mutation requests; trusted local processes still have test-chain administration access.

Stop the app and finish any pending agent inference before upgrading an existing local vault. Build the new WASM, then run `npm run sandbox:upgrade` → back up the stopped chain, saved databases, metadata and local keys into a private `work/upgrade-backups/` directory, then deploy the pinned code to the same account. All raw contract storage, invoice states, budget, signing permissions, recipient balances and local database records must match afterward. This includes policy and merchant-bill records absent from the UI. Backups contain disposable signing keys: keep them private and never commit or upload them. No initialization, payment recovery, funding or database reset runs during an upgrade.

Snapshots wait for the observed chain head to become final and read at one fixed block. An Executing payment blocks deployment until its callback resolves; expiry does not bypass this check. A directory lock excludes the app and agent commands. A durable `upgrade-pending.json` blocks their startup if deployment or verification is interrupted. Re-run the same upgrade with the same built artifact → verify the saved evidence and, if the code is already installed, finish without deploying again. If the artifact, storage or saved records disagree, the command stays blocked; retain the backup and investigate rather than deleting the marker or overwriting data. This is a state-preserving local code upgrade, not a general state migration. See [NEAR contract upgrades](https://docs.near.org/smart-contracts/release/upgrade) and [RPC state queries](https://docs.near.org/api/rpc/contracts).

`npm run test:upgrade` → deploy a distinct WASM artifact on a disposable vault containing UI, inbox, policy, signed-bill and dry-route records; kill the upgrader after deployment; confirm startup remains blocked; then recover with identical data and no second deployment or payment. The test also rejects an unlisted in-flight invoice. New controls are exercised on this disposable vault, including owner-only cleanup and retained reservations. For an agent vault, use `COUNTERSIGN_SANDBOX_DIR="$PWD/work/agent-vault" npm run sandbox:upgrade`. Existing policy expiry and minimum settings are preserved; upgrading never silently renews permission to spend.

1Click remains dry-run only. The desk checks NEAR/Base address formats, clears quotes after edits or failed verification, displays bounded JSON validation messages, and requires the pinned observed app-fee recipient/rate at 1 basis point. A missing, stripped or different app-fee entry fails closed; unsigned timing/refund/withdrawal estimates are explicitly labelled and excluded from trusted payment amounts. Raw response metadata remains untrusted even when its full hash is included in owner consent.

## Delegated spending policies (native NEAR only)

`npm run agent:policy:demo` → an owner sets a merchant account, a 0.1 NEAR per-payment cap, a 0.15 NEAR rolling budget and one-hour policy expiry. A fixture response passes through the same NEAR AI proposal parser and restricted tool as live inference; the contract authorizes it under those rules and the normal executor settles it once. Replaying it pays nothing; a second 0.1 NEAR invoice is rejected. No owner authorization call is needed for each invoice, no paid model inference occurs, and all funds are disposable local test NEAR.

Owner-only `set_policy({merchants:[{id,payee}],per_payment,daily_limit,expires_at})` installs rules. Amounts are integer yoctoNEAR strings; expiry is decimal milliseconds within 30 days. `revoke_policy()` stops new policy authorizations and unexecuted policy payments. Only the configured executor may call `authorize_by_policy({invoice,merchant_id,expires_at?})`. An allowed merchant ID must match its pinned payout account. The trusted host can opt `InvoicePaymentTool` into that route by supplying its fifth argument, the pinned merchant ID; the model still receives only the restricted invoice-ID tool.

The rolling allowance counts unexpired, never-reserved approvals, all Reserved/Executing holds, and settled transfers dispatched within the last 24 hours. An expired Authorized entry drops out only if it has no attempt or dispatch record. Missing expiry/evidence retains the charge. Reserved and uncertain Executing payments never age out, even after invoice expiry. Once settled, an entry ages out exactly 24 hours after dispatch; confirmed failure or cancellation releases its charge once. Authorizing reserves policy quota atomically, so parallel invoices cannot overbook it. Repeating identical authorization does not charge twice. Rules are rechecked at reservation and execution. Updating/revoking a policy invalidates its unexecuted approvals and never resets prior spending history. The owner can immediately cancel a Reserved invoice bound to a revoked or replaced policy version, without waiting for invoice expiry; a still-valid reservation must expire first. Executing invoices remain uncancellable. Use `get_policy` and `policy_usage` to inspect the rules and current charge total.

This MVP permits at most 32 merchants, 16 undispatched policy charges (Authorized or Reserved), and 128 total outstanding/recent charges per vault. New policies default to a minimum invoice of 1% of the per-payment cap, rounded up to whole base units; the owner may set `min_payment` explicitly from 1 yoctoNEAR through the cap. Existing policies without the new minimum record retain 1 yoctoNEAR until reconfigured. These bounds limit dust/abandoned-approval spam; an authorized malicious executor can still consume allowed capacity. The owner can pause/revoke its authority and clear unreserved approvals in one bounded call. Active Reserved/Executing charges and recent settled spending still block capacity until safely resolved or aged out. Policy configuration and invoice bindings use separate storage prefixes; existing native invoice commitments retain their original format. Manual `authorize` remains an owner override for payees outside weekly service protection. Failed policy authorization does not consume the invoice ID.

`npm run test:policy:sandbox` → checks automatic payment, duplicate protection, redirected/unknown merchants, per-payment and rolling caps, concurrent requests, owner-only configuration, revocation/version changes, expiry and manual overrides. Rust tests check exact rolling-window boundaries and retained uncertain holds. Merchant allowlisting alone does not authenticate an invoice. Enable the merchant signature checks below to bind a merchant key and stable bill ID; the optional weekly agreement below also binds different bill IDs to a single service period. 1Click approvals do not use these policies and cannot move funds.

## Live agent with spending policies

Set `NEAR_AI_API_KEY` and `NEAR_AI_MODEL` in the ignored project `.env` or your environment. See `.env.example` for the field names and the [NEAR AI model catalog](https://docs.near.ai/cloud/models) for current tool-calling support. Then run:

```sh
npm run agent:policy:demo -- --live-model
```

→ A fresh local vault receives disposable test funds. The owner installs merchant/cap/budget/expiry rules once. Two live model requests propose synthetic invoices: the first pays 0.1 test NEAR without per-invoice owner authorization; replay pays nothing; the second 0.1 invoice exceeds the 0.15 rolling allowance and is rejected on chain. The command verifies recipient balances, policy usage and absence of an authorization for the rejected invoice. It closes the test chain afterward and never opens the existing desk vault. Live inference consumes provider credits; payment funds are exclusively local test NEAR. There is no mainnet/RPC override or automatic fixture fallback.

The model receives only structured invoice fields and `request_payment({invoice_id})`. Merchant identity, policy configuration, invoice terms, keys and execution transport remain host-controlled. A valid model response grants no authority on its own: current on-chain rules decide authorization. No 1Click execution is connected.

`npm run test:agent:policy:sandbox` → the same provider adapter with offline HTTP fixtures checks malformed/redirected proposals, provider failures, interrupted authorization recovery, duplicate protection, over-budget rejection and revocation while inference is in flight. These regression tests use no API key or inference credits. `npm run agent:policy:demo` keeps the complete command offline except for its local test chain.

## Persistent agent inbox (local test funds only)

The live demo is disposable. For invoices and policies that survive separate command invocations, use the independent local agent vault under ignored `work/agent-vault/`:

```sh
npm run agent:desk -- init
npm run agent:desk -- policy 0.1 0.15 60
npm run agent:desk -- enqueue INV-001 0.1
npm run agent:desk -- run INV-001
npm run agent:desk -- status
```

→ Initialize once, set a 0.1 NEAR per-payment cap / 0.15 rolling allowance / 60-minute expiry, persist one invoice, pay it with a fixture proposal, and inspect the same vault's payment and policy usage. `init` on existing data does not replace the vault, fund again, reset policy or clear history. Only `init` can create a missing agent vault. The harness pins invoices to its disposable local merchant; it cannot select an external payment network or RPC. `COUNTERSIGN_AGENT_DIR` selects a separate local state directory for tests. The development owner/executor keys remain with the trusted host.

For live inference, enqueue a new invoice within the remaining allowance and run `npm run agent:desk -- run INV-002 --live-model` → the same restricted NEAR AI proposer uses the saved owner policy. Live requests consume inference credits. Re-running an invoice with a saved proposal or terminal result does not call the model again. Model keys are loaded only if a new proposal is needed.

To renew the existing policy without replacing any limits or merchant settings, first build and upgrade the saved local vault as described above, then:

```sh
npm run agent:desk -- renew-policy 60 renewal-001
```

→ The owner extends the policy to 60 minutes from the chain's current time. The merchant list, pinned payout accounts, minimum, per-payment cap and rolling budget are preserved exactly, including a legacy minimum of 1 yoctoNEAR. Existing spending, Reserved/Executing holds, invoice records, signing keys and used bill IDs remain intact. An active policy can be renewed only to a later deadline. Renewal changes the policy version: old unexecuted approvals stay invalidated, their original invoice deadlines never extend, and in-flight payments keep their holds until confirmed settlement. Owner cancellation may release an unexecuted reservation bound to the old version; it cannot cancel Executing payments.

On a new request the CLI waits for a block produced after it connects to become final, then reads the policy and its clock at that exact block. This also works on a saved vault running the earlier renewal contract. If the chain stalls, retry the same command when it resumes.

If the command is interrupted or reports an unconfirmed outcome, repeat **the same command and renewal ID** → reconcile the fixed saved expiry and on-chain receipt without extending permission again. Another ID stays blocked while the request is unresolved. A previously recorded request whose deadline elapsed can return `expired`. Use a new ID for a new owner-approved renewal after that result. Even after expiry or revocation, replay cannot create new authority. A stale request cannot overwrite rules changed by the owner. The owner initiates each renewal. The private intent records stay under `work/agent-vault/policy-renewals/`.

`npm run test:policy:renewal` → kill the actual CLI after the chain accepts renewal, recover once, preserve custom settings/signatures/bills/held quota, reject competing stale renewals and verify a new fixture-agent payment stays within the original rolling budget. All funds are disposable local test NEAR. Rust tests additionally preserve uncertain Executing holds past expiry; offline tests cover lost responses before submission and expired or superseded saved requests.

Every invoice and merchant binding is durable before inference. Inference is claimed once across workers; the validated single-tool proposal is durable before any authorization or payment call. `npm run agent:desk -- resume` → reconcile all saved proposals using the original invoice and attempt; this command never calls a model. Add an invoice ID to resume just that record. Payment errors remain attached to the record for inspection, and unknown outcomes keep the saved proposal for reconciliation.

If a process stopped during inference, the state is `inference_pending`; malformed/provider-failed requests become `proposal_failed`. Neither retries automatically. `npm run agent:desk -- retry-proposal INV-002`, then `run INV-002 [--live-model]` explicitly permits another inference attempt. A late response from the old attempt cannot overwrite the new one or trigger payment. This retry does not clear an accepted proposal, payment attempt, invoice ID or spending history.

Owner commands: `revoke` stops new policy payments; `policy <per-payment NEAR> <rolling NEAR> <minutes>` explicitly updates rules. `cancel INV-001` asks the contract to cancel the exact imported signed bill even before authorization, or an Authorized or eligible Reserved invoice, and records cancellation only after confirming the exact contract result. Executing/settled payments cannot be locally cancelled or have their funds released. Interrupted inference remains blocked until explicitly retried unless the owner confirms cancellation. The local chain persists after the command exits, like the existing desk; your existing app vault and 1Click records are separate.

`npm run test:inbox:sandbox` → kills separate worker processes during inference and after saving a proposal, reopens the same vault, resumes with deliberately empty model credentials, verifies exactly one payment, and requires explicit retry for interrupted inference. It also checks confirmed cancellation and that repeated initialization preserves the vault and policy history. All automated tests use fixture proposals and local funds.

## Merchant-signed invoices

`npm run agent:signed:demo` → a disposable merchant key signs a synthetic invoice for a fresh local vault; a forged amount is rejected at intake; the genuine invoice pays 0.1 test NEAR once; replay pays nothing. This exercises the actual `agent:desk` commands and makes no live model call. The fixture merchant private key exists only in the demo process, never in the agent child, model prompt or repository. Optional `-- --live-model` uses one provider request and still only local payment funds.

For an existing agent vault, first build the new contract, then run `COUNTERSIGN_SANDBOX_DIR="$PWD/work/agent-vault" npm run sandbox:upgrade` with no agent command running. This applies the existing state-preserving local upgrade; no reset or automatic upgrade is performed. The new inbox column migrates transactionally and retains existing records, including settled `INV-001`.

Owner setup: `npm run agent:desk -- merchant-key local-merchant PUBLIC_KEY_BASE64` → pin a 32-byte Ed25519 public key and print its version, vault and signing domain. Obtain and authenticate the merchant public key independently; this CLI does not establish a real-world merchant identity. The command creates a random 32-byte deployment domain once. Contract `configure_invoice_auth` makes that domain immutable; use a distinct domain for every deployment, even if account names/keys are reused.

Merchant-side `signInvoice` in `merchant/invoice.ts` signs the exact invoice, merchant ID, stable bill ID, vault, domain, key version and millisecond expiry (at most 24 hours and no later than policy expiry). Transfer amounts are integer yoctoNEAR strings. The envelope contains `invoice`, `merchant_id`, `bill_id`, `vault`, `domain`, `key_version`, `expires_at`, and a canonical base64 64-byte `signature`. Signing bytes are UTF-8 `COUNTERSIGN-SIGNED-INVOICE-V1\n` followed by byte-length-prefixed fields in this order: domain, vault, merchant ID, bill ID, key version, expiry, invoice ID, payee, asset, amount. The model still sees only the four invoice fields and its restricted invoice-ID tool.

`npm run agent:desk -- import /absolute/path/signed-invoice.json` → verify against the current vault/domain/key before persisting it. Then `run INVOICE_ID [--live-model]` or `resume INVOICE_ID` uses the durable inbox. The contract independently verifies the Ed25519 signature with [NEAR's host verification function](https://docs.rs/near-sdk/5.30.0/near_sdk/env/fn.ed25519_verify.html), applies the existing policy, and atomically binds `(merchant_id, bill_id)` to one invoice ID. A cancelled or failed signed bill cannot be reused under a new invoice ID. `get_invoice_auth` reads its stored signature-payload hash and key version.

Once a merchant has a key record, direct unsigned policy authorization is blocked, including after revocation. Existing unexecuted unsigned policy approvals for that merchant are also blocked. `revoke-key MERCHANT_ID` revokes signing authority; `merchant-key` rotates it with a new version. Both invalidate unexecuted signed approvals; they do not erase spending or bill history, cancel uncertain transfers, or release holds. Expired reserved holds still use owner `cancel`; revoking or replacing the spending policy also makes an unexecuted policy reservation eligible. Changing only a merchant key does not by itself enable early cancellation. For payees outside weekly service protection, manual owner approval remains an override and merchants without a key retain the host-trusted fixture path.

`npm run test:merchant` and `npm run test:merchant:sandbox` → check every signed term, strict encodings, expiry, wrong vault/domain, unauthorized key management, unsigned bypass, private-helper inaccessibility, duplicate bill races, replay after cancellation/rotation, payout pinning, key revocation and persistent inbox recovery. The full `demo:verify` suite includes these tests. Signed invoices currently cover native NEAR only; 1Click remains non-fundable dry-run.


## One payment per service week

`npm run test:weekly` → two different, genuinely signed 0.04 NEAR bills race for the same service week on a fresh local vault. The worker loses its transfer acknowledgement and is killed. After policy renewal and restart, retrying both bills shows one settled invoice, one blocked invoice naming the winner, a merchant credit of 0.04 and 0.11 of rolling allowance left. A new signed bill pays after the local chain crosses the weekly boundary.

`npm run test:upgrade:weekly -- --step` → run the teammate retest from a prepared checkout with both commits in its Git history. It builds `aa5efa2` and `ba82413`, settles two older signed bills for 0.03 local test NEAR in total, and upgrades the same disposable vault. At each prompt inspect the preserved receipts, the worker crash and both retries. The weekly bills pay 0.04 once, retries pay 0.00, and the vault has 4.93 left. The command prints a shareable `result.json`; keep the vault backup and its signing keys private. Omit `-- --step` for an unattended run.

To enroll a supplier on a saved local vault, first apply the state-preserving vault upgrade, configure its spending policy and pin its merchant key as described above. This example uses Monday 00:00 UTC as the weekly boundary.

```sh
npm run agent:desk -- weekly-service compute local-merchant 0.10 345600000
npm run agent:desk -- service-status compute
```

The owner pins the agreement to the merchant's policy payout account, a maximum payment and a UTC anchor in Unix milliseconds. Each period lasts exactly seven days from that anchor. The merchant passes the returned `service` object to `signInvoice` alongside its usual invoice fields. V2 signs the same fields as V1 under `COUNTERSIGN-SIGNED-INVOICE-V2\n`, followed by the agreement ID and exact period start in the same length-prefixed encoding. Import and run the signed file using the existing desk commands.

The vault checks the current week on its own clock. The first valid authorization claims the week atomically with its policy charge. Dispatch must begin before both the invoice expiry and the end of the week. Cancellation, confirmed failure, lost responses and policy or key replacement all preserve the claim. To inspect an earlier week, run `service-status compute <period-start-ms>`.

**Correct a weekly bill before reservation.** Import both merchant-signed bills into the local agent desk. Use `prepare-weekly` to authorize the original under the spending policy and stop before reservation. Skip that step if it already holds the current week. The owner can also correct a previously cancelled, never-reserved bill.

```sh
npm run agent:desk -- prepare-weekly ORIGINAL-ID
npm run agent:desk -- correct-weekly ORIGINAL-ID CORRECTED-ID
npm run agent:desk -- run CORRECTED-ID
```

The correction returns the replacement authorization. It switches the weekly claim and spending allowance together, checks both bill identities and keeps the original cancelled. The replacement needs fresh invoice and merchant bill IDs, the same merchant, payout account and service week, and an equal or lower amount within current policy. Repeating the same correction returns the replacement's recorded state. The final command runs the usual agent payment and recovery flow.

Run `npm run test:weekly:correction` after building the contract. When the correction wins, the merchant receives 0.03 local test NEAR. When reservation wins, the owner sees “Correction requires a never-reserved bill” and the merchant receives 0.04. Each run kills the paying worker after settlement and checks that retrying both bills adds 0.00.

Enrollment protects future dispatches to that payout account, including older unexecuted plain approvals and alternate merchant names. Payments already dispatched keep their original outcome. The owner can stop future authorizations and dispatches with `revoke-service compute`. Revocation preserves claims and the signature requirement. Each separately approved agreement has its own weekly allowance. Duplicate detection outside a defined service period still relies on the merchant's bill ID.

## Emergency pause and executor replacement

`npm run test:controls:sandbox` → deploy disposable local vaults, pause every native payment entry point, replace the executor, reject the old credentials, and resume the original reserved attempt exactly once. A separate CLI test proves that owner commands cannot silently pay pending invoices at startup and that reconnecting reads the current executor from the chain even if local metadata is stale. No live model, inference credits, swaps or real funds are used.

For your existing agent vault, build and explicitly upgrade it as described above before using these commands; existing records are retained. Then:

```sh
npm run agent:desk -- pause
npm run agent:desk -- rotate-executor executor-recovery-1
npm run agent:desk -- status
npm run agent:desk -- unpause
npm run agent:desk -- resume
```

→ Pause new native authorizations, reservations and transfer dispatch; replace the local executor while keeping the vault paused; inspect its on-chain owner/executor/pause state; deliberately unpause; explicitly reconcile saved proposals using their original attempt IDs. Rotation creates a disposable local account with 1 test NEAR for transaction costs. Repeating the same label reuses the account and key without funding it again. The chain determines the active executor; cached metadata cannot restore the old executor's vault authority. A long-running app must reconnect to pick up the new signer. The local CLI serializes chain operations, but releases its command lock while awaiting a model proposal. Owner pause, executor replacement and policy/key changes can complete during inference. Before payment, the runner reconnects to the same vault, picks up the current executor, rechecks pause, and applies the current on-chain policy and signature rules. An already-dispatched transfer still cannot be recalled.

Only the owner can pause, unpause or replace the executor, and replacement requires the vault to be paused. A pause takes effect when its transaction executes; it cannot recall a transfer already dispatched. Transfer callbacks, reads, owner cancellation of eligible invoices, and release of confirmed legacy failures still work during a pause. Reservations, invoice commitments, attempt IDs, merchant bill bindings and spending history are preserved. Executing payments remain held until their callback resolves; pausing never releases an uncertain payment's budget. Policy/key revocation remains separate from replacing the executor.

Agent CLI startup now leaves payment recovery to explicit `run` or `resume` commands. In particular, `pause`, `status`, `unpause` and `rotate-executor` do not pay anything merely by opening the saved vault. `run` rejects a paused vault before requesting a new model proposal. The default app restart recovery remains enabled and is subject to the same on-chain pause. Legacy contracts without emergency controls remain readable but require the explicit upgrade to gain this protection. The pause flag uses separate storage; the existing root state layout is unchanged. These controls currently cover native NEAR payments; 1Click stays non-fundable dry-run.

`npm run test:owner:inference` → hold a fixture model response open while separate owner commands pause, rotate and revoke authority. Late proposals cannot pay a paused/revoked vault or a changed vault identity; an accepted saved proposal resumes once without another model request. All chains and keys are disposable local test fixtures.


## Policy allowance recovery

After building and explicitly upgrading an existing local vault, `npm run agent:desk -- capacity` → inspect the minimum, pending/total capacity and current charged allowance. `npm run agent:desk -- policy 0.1 0.15 60 0.001` → set a 0.001 NEAR minimum alongside the existing cap, rolling budget and expiry. The fourth value is optional; new policies use the 1% default when omitted.

`npm run agent:desk -- clear-approvals` → the owner cancels **all never-reserved policy approvals**, including fresh ones, in one bounded transaction. Their invoice IDs and signed bill bindings stay used. Reserved, Executing and Settled entries are excluded. It works while paused; repeated cleanup does not release extra budget. Known inbox records are reconciled to cancellation, and a missed local update can recover the terminal on-chain result without another payment or model request.

Expired never-reserved approvals disappear from `policy_usage` immediately at the chain's expiry boundary. Their ledger entries are compacted on a successful new policy authorization or owner cleanup; their invoice records are retained and cannot be reused. No vault balance is credited by automatic expiry pruning because those invoices never reserved native funds.

`npm run test:policy:recovery` → verify expiry pruning, retained expired reservations, dust rejection, pending-cap exhaustion, bulk recovery, cleanup/reservation races and clean CLI failure reasons on disposable local chains. The signed-invoice integration test also rewrites both the SQLite invoice and commitment, then strips its signature: both attacks are rejected before authorization. The exact 24-hour settlement-aging boundary remains covered by the Rust clock-boundary test; no successful real-chain 24-hour fast-forward is claimed.

## Agent payments in the desk

Run `npm run dev` → open http://127.0.0.1:4317/#agent-payments. The page runs the same agent flow as the CLI on the local agent vault (`work/agent-vault`, or `COUNTERSIGN_AGENT_DIR`). It calls the same functions as `agent:desk import`, `run` and `resume`; it adds no payment logic. All funds are local test NEAR.

Set the vault up once from the terminal. The page cannot create a vault, change rules or pin a supplier key:

```sh
npm run agent:desk -- init
npm run agent:desk -- policy 0.5 0.8 120
npm run agent:desk -- merchant-key local-merchant PUBLIC_KEY_BASE64
```

- **Import signed bill** → choose a supplier's JSON file, or expand **Paste JSON instead**. The signature is checked against the pinned key before anything is saved. A rejected file shows its reason, such as `Invalid merchant signature`. Importing the same file again shows "Already imported" and keeps the one saved record.
- **Request payment** → see Paid, Blocked or Pending with the recorded reason, such as "Merchant bill already used." or "Rolling daily budget exceeded." Blocked bills move no funds.
- **Use live AI** is off by default, so the fixture proposer runs and no model is called. Tick it to send that one bill to NEAR AI; this needs `NEAR_AI_API_KEY` and `NEAR_AI_MODEL` and otherwise answers "No model key configured".
- **Resume** → reconcile a saved proposal using its original attempt. It never calls a model.
- **Receipt** on a paid bill → the attempt ID and the signed payload hash stored by the vault. The transaction hash is not available for local receipts.
- **Spending rules** → see the per-payment cap, rolling 24-hour budget, pause state and pinned suppliers. Expand **Policy details** for the minimum and expiry.

Only one request or resume runs at a time. Each action takes the vault's command lock, so while an `agent:desk` command is running the page reports "Agent vault is in use by another process"; retry when it finishes. Without a vault the page shows "No agent vault yet. Run npm run agent:desk -- init first."

`npm run test:app` → check request validation, the 16 KB limit, the one-at-a-time rule and the missing or locked vault messages with fake dependencies. `npm run test:sandbox` includes `integration/agent-desk-web.test.ts` → on a fresh local vault, a signed bill imported through the route pays once, a forged amount is rejected at import, an identical re-import adds no record or payment, the same supplier bill under a new invoice ID is blocked, an over-budget bill is blocked, and the merchant's on-chain balance rises by exactly one payment.

## Ask Dave

Dave can write a short conversational reply above the cited facts. Amounts, outcomes and explanations must match the specific selected bill or budget field; unsupported claims or phrasing leave the exact facts visible instead. The reply may greet you and combine supported statements, but it cannot promise a payment will succeed. Set `COUNTERSIGN_ASK_VOICE=off` for facts only.

Start the saved local chain with `npm run agent:desk -- status`. Ask Dave reads the inbox and consults the vault at a single block. It has no signing key or payment tools.

- `npm run agent:desk -- ask --facts` → see the invoice outcomes, supplier totals, available balance, spending rules and unusual activity. This command runs locally.
- `npm run agent:desk -- ask --check /absolute/path/signed-invoice.json` → see whether the signature, payout account, amount and service week fit the vault’s rules at that block. A bill without a service week gets a red flag if either the supplier or payout account is enrolled, even before the first weekly invoice arrives. The checker also reads the vault’s bill register, so a duplicate supplier bill is caught even after local inbox history is lost. An older vault missing a required lookup reports `cannot verify`.
- `npm run agent:desk -- ask "Why was INV-001 blocked?"` → see the recorded reason and the invoice and block used to answer. For a control, try `npm run agent:desk -- ask "Are payments paused?"`.
- `npm run test:ask` → verify the explanations, citations and invoice checks with fixture replies. `npm run test:ask:sandbox` → reproduce the paid, tampered, duplicate, over-budget and weekly bills on a disposable local chain.

Natural-language questions send the question and available evidence to NEAR AI using the configured `NEAR_AI_API_KEY` and `NEAR_AI_MODEL`. The model selects records. Countersign supplies the amounts, outcomes, pause setting and citations from those records. An unsupported model reply produces “I couldn't verify that answer.” Set `COUNTERSIGN_ASK_DEBUG=1` to see the reason.

Supplier totals count payments with a matching invoice commitment and signed supplier receipt. Transfers lacking that evidence appear in `totals.unattributed`. The inbox has no payment timestamps, so the weekly answer uses signed service periods and the daily budget uses the vault’s rolling 24-hour usage. The facts list weekly services named by inbox bills. Files rejected at import have no inbox record.
