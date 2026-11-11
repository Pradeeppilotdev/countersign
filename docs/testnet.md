# Public NEAR testnet deployment

## Verified deployment — 10 November 2026

- Contract: [`countersign-vault-7d8cc5331e.testnet`](https://testnet.nearblocks.io/address/countersign-vault-7d8cc5331e.testnet).
- Owner: `countersign-owner-7d8cc5331e.testnet`.
- Executor: `countersign-executor-7d8cc5331e.testnet`.
- Merchant: `countersign-merchant-7d8cc5331e.testnet`.
- [Atomic deploy + initialization](https://testnet.nearblocks.io/txns/oJUpEicSuoRmShaCmPHzoE9mfyDEDXk4PLG8UTJeori): `oJUpEicSuoRmShaCmPHzoE9mfyDEDXk4PLG8UTJeori`.
- [Rejected second initialization](https://testnet.nearblocks.io/txns/BUPfU1Rc2asceGRaSWHrJsdJHNu5548FxitkF818rpDB): `BUPfU1Rc2asceGRaSWHrJsdJHNu5548FxitkF818rpDB`.

Final RPC outcomes confirmed deployment success and the rejection
`The contract has already been initialized`. Finalized views confirmed the above
owner/executor, `paused: false`, and `available_balance: "0"`, unchanged after the
rejected call. Contract source revision: `7546640945e3ba1833f3fed11a3f6cc9e1018fc2`.
Deployed WASM SHA-256:
`0d71932a2abea5e6445bec4da7788e3cb65063f89257bf3c61058692aafc1583`.

Step 1 local validation passed: 37 Rust unit tests, 3 offline deployment
checks, 60 JavaScript unit tests, 17 sandbox integration tests, and the full app
crash/chain restart check. `npm run demo:verify` ended with `ALL CHECKS PASSED`.
Rerunning testnet deploy/verify recovered the same recorded transaction hashes
without submitting additional transactions.

The `testnet` package’s `vault` command supports **deployment and verification only**.
The separate opt-in café command below funds the vault and exercises policy payments. Neither
command calls a model API. The local app, `agent:desk`, demos and tests keep their existing sandbox
behavior, including when `COUNTERSIGN_NETWORK` is set. Use `COUNTERSIGN_PORT=4417`
if running the app from this checkout.

## Deploy from the repository root

Use the Node/Rust prerequisites in [the local guide](local-guide.md#quick-start).

```sh
npm ci --ignore-scripts
npm ci --prefix testnet --ignore-scripts
cargo build --locked --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release
COUNTERSIGN_NETWORK=testnet npm --prefix testnet run vault -- accounts
COUNTERSIGN_NETWORK=testnet npm --prefix testnet run vault -- deploy
COUNTERSIGN_NETWORK=testnet npm --prefix testnet run vault -- verify
```

The network selector is mandatory for this command. Only `testnet` is accepted;
the RPC is pinned to `https://test.rpc.fastnear.com` and account creation uses the
official `https://helper.testnet.near.org/account` faucet. No API subscription,
mainnet funds, external wallet, `.env` credentials or paid inference is used.
The RPC was switched to the free public FastNEAR testnet endpoint after the
original `https://rpc.testnet.near.org` repeatedly returned 429/deprecation
responses. The network, vault, accounts and saved transaction hashes are unchanged.

`accounts` generates four separate random `.testnet` names and Ed25519 keys for
owner, executor, merchant and vault. It saves each key **before** requesting its
faucet account, then checks the full-access public key on chain. Rerunning uses
the same saved accounts and keys. The fourth account holds the contract; its
deployment key stays separate from the executor.

`deploy` sends one self-signed transaction to the vault containing exactly
`DeployContract` followed by `FunctionCall(new, {owner, executor})`. The contract's
private initializer remains unchanged. Deployment refuses to overwrite an
existing contract without its recorded transaction and checks the on-chain code
hash against the local WASM. This follows NEAR's supported
[initialization during deployment](https://docs.near.org/smart-contracts/release/deploy#initializing-the-contract).

`verify` reads `get_vault_controls` and `available_balance` at finality `final`.
It then signs a second `new` **as the vault itself**, so the test proves the
already-initialized guard rather than only the private-method guard. The
transaction must fail specifically with “already been initialized”; both views
must remain unchanged. Its failed transaction is expected public evidence.
The initial available invoice budget is `"0"`: faucet account balance covers
storage/gas but is not a deposit through the owner-only `fund` method.

Read current controls/budget without loading keys or sending transactions:

```sh
COUNTERSIGN_NETWORK=testnet npm --prefix testnet run vault -- status
```

## Local files and interrupted runs

Everything generated stays under gitignored `work/testnet/`. The directory is
mode `0700`; JSON and key files are mode `0600`. Never commit or upload this
directory, print the `*.key.json` files, or share them with an agent/model.

- `accounts.json`: public role/account mapping.
- `owner.key.json`, `executor.key.json`, `merchant.key.json`, `vault.key.json`: private credentials.
- `deploy.json`, `reinitialize.json`: transaction hashes and final RPC outcomes.
- `verification.json`: public verification evidence, with no keys.

A directory lock prevents concurrent deploy commands. A transaction hash is
saved before broadcasting; reruns query that same hash instead of signing a new
deployment or reinitialization. If a send has an uncertain result, rerun the same
command to reconcile. An unknown/expired transaction stops for manual inspection;
do not delete its journal and retry blindly. Faucet failures also stop safely;
rerun `accounts` to check whether creation succeeded before requesting it again.
Keep these files to retain access and evidence. No global NEAR keystore is used.

The vault's full-access deployment key remains an administrative trust boundary:
it can upgrade code or transfer account funds. This is a testnet prototype, with
no production custody/key-removal claim.

## Checks and explorer links

```sh
npm --prefix testnet test  # offline deployment, journal recovery and rejection checks
cargo test --locked --manifest-path contract/Cargo.toml
COUNTERSIGN_PORT=4417 npm run demo:verify
```

CI runs the isolated testnet checks separately from the local verification runner.
Neither check submits a testnet transaction. The separate package pins `near-api-js`
to `5.1.1` without changing the root lockfile required by the pinned upgrade test.
Public account pages use
`https://testnet.nearblocks.io/address/ACCOUNT`; transactions use
`https://testnet.nearblocks.io/txns/HASH`. Deployment output prints the account
page; the verified hashes are recorded in `verification.json`.

## Dave's café on testnet

From the same checkout, with the Step 1 accounts and keys still in `work/testnet/`:

```sh
COUNTERSIGN_NETWORK=testnet npm --prefix testnet run cafe
```

This is an explicit live testnet action. It deposits **2 faucet NEAR** from the
owner, pins the merchant account's Ed25519 signing key under `daves-cafe`, and sets
a **0.5 NEAR per-payment cap, 0.8 rolling daily budget, 0.01 minimum, and four-hour
expiry**. The owner sets these rules once; the executor requests each signed
payment under policy without calling owner `authorize`.

The runner pays a valid 0.4 NEAR bill, submits a payee-tampered signed invoice,
submits a freshly signed new invoice ID for the already-used merchant bill, and
submits a valid 0.5 NEAR bill that would take usage to 0.9. All three rejection
cases are real `authorize_signed_invoice` transactions, deliberately bypassing
local validation. A new signature on the duplicate bill ensures that its rejection
tests bill identity rather than signature validity.

For the last 0.3 NEAR invoice, a separate executor process uses the existing
`InvoicePaymentTool` and persistent `Executor`. The supervisor observes the
finalized `Reserved` state, unchanged merchant balance and a SQLite `claimed`
attempt, then kills that worker with **SIGKILL**. A fresh process reopens the same
database and persisted fixture proposal and resumes the same attempt to `Settled`.
Both successful cases also submit a duplicate `execute` transaction and check
that merchant balances do not increase again. Total merchant credit is 0.7 NEAR;
remaining vault deposit budget is 1.3 NEAR. There are zero live model calls.

Private keys are reused directly from `work/testnet/*.key.json`; no keys are
written elsewhere. Public signed invoices, fixture proposals, the SQLite attempt
records, process-kill observations, full RPC outcomes and the final report stay in
`work/testnet/cafe/`. `report.json` contains public evidence only. Never publish the
whole directory or credential files. The README links to a reviewed public report.

Reruns reuse the saved plan, transaction hashes and completed cases; they do not
fund again or reset policy usage. A completed run prints its saved report. New
café journals contain the full encoded signed transaction in base64, saved before
sending alongside its hash. These bytes
contain a signature, not a private key. A retry broadcasts exactly those bytes
with the same nonce and hash, then waits for FINAL; it never signs a replacement.
If the node already knows or has processed the transaction, the runner queries
the saved hash. If broadcast reports expiry and status reports unknown, the
record is marked `never_sent` with a reason and stops for manual inspection.
An RPC outage alone cannot establish that state. Legacy hash-only journals query
status once and stop clearly if unresolved; they cannot safely re-broadcast.
Changed arguments are rejected before any send. Requests are paced; RPC 429
responses keep their three bounded backoff retries against the same endpoint. Do not
delete journals to force a retry, and do not reuse this harness to alter a vault
that has unrelated policy activity. An expired unfinished plan needs inspection;
the runner does not silently renew its permissions or invoices.

For the specific case where (a)–(d) finished but the unstarted restart invoice was
rejected for expiry, the inspected recovery command is:

```sh
COUNTERSIGN_NETWORK=testnet npm --prefix testnet run cafe -- --renew-unstarted-restart
```

It requires no payment/auth record or reservation for that invoice, verifies the
original limits and 0.4 NEAR usage, and calls owner `renew_policy` to extend only
the deadline by four hours. It verifies usage and the 1.6 NEAR available budget
remain unchanged. A fresh invoice ID/signature for the same unconsumed bill uses a
new transaction journal prefix; the expired invoice and its failed transaction
are preserved in the public report. This does not grant per-invoice owner approval.

The merchant-side utility signs public invoice payloads; the fixture proposer sees only
invoice terms and requests the assigned invoice ID. The three adversarial cases
are direct contract probes, separate from the ordinary agent capability. This
testnet runner does not switch the local app or `agent:desk` onto testnet.
