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

Local validation on this branch passed: 37 Rust unit tests, 3 offline deployment
checks, 60 JavaScript unit tests, 17 sandbox integration tests, and the full app
crash/chain restart check. `npm run demo:verify` ended with `ALL CHECKS PASSED`.
Rerunning testnet deploy/verify recovered the same recorded transaction hashes
without submitting additional transactions.

This command supports **deployment and verification only**. It does not enable the
café/payment flow, fund the vault's invoice budget, configure policies or call a
model. The local app, `agent:desk`, demos and tests keep their existing sandbox
behavior, including when `COUNTERSIGN_NETWORK` is set. Use `COUNTERSIGN_PORT=4417`
if running the app from this checkout.

## Deploy from the repository root

Use the Node/Rust prerequisites in [the local guide](local-guide.md#quick-start).

```sh
npm ci --ignore-scripts
cargo build --locked --manifest-path contract/Cargo.toml --target wasm32-unknown-unknown --release
COUNTERSIGN_NETWORK=testnet npm run testnet -- accounts
COUNTERSIGN_NETWORK=testnet npm run testnet -- deploy
COUNTERSIGN_NETWORK=testnet npm run testnet -- verify
```

The network selector is mandatory for this command. Only `testnet` is accepted;
the RPC is pinned to `https://rpc.testnet.near.org` and account creation uses the
official `https://helper.testnet.near.org/account` faucet. No API subscription,
mainnet funds, external wallet, `.env` credentials or paid inference is used.

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
COUNTERSIGN_NETWORK=testnet npm run testnet -- status
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
npm run test:testnet  # offline selector, atomic actions and rejection-proof checks
cargo test --locked --manifest-path contract/Cargo.toml
COUNTERSIGN_PORT=4417 npm run demo:verify
```

The full local verification runner includes the offline deployment checks.
It never submits a testnet transaction. Public account pages use
`https://testnet.nearblocks.io/address/ACCOUNT`; transactions use
`https://testnet.nearblocks.io/txns/HASH`. Deployment output prints the account
page; the verified hashes are recorded in `verification.json`.
