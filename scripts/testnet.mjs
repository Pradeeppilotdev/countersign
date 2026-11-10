import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {join} from 'node:path';
import lockfile from 'proper-lockfile';
import {connect, KeyPair, keyStores, transactions, utils} from 'near-api-js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = join(root, 'work/testnet');
const wasmPath = join(root, 'contract/target/wasm32-unknown-unknown/release/countersign.wasm');
const roles = ['owner', 'executor', 'merchant', 'vault'];
const emptyCode = '11111111111111111111111111111111';
export function testnetConfig(network) {
  if (network !== 'testnet') throw Error('Set COUNTERSIGN_NETWORK=testnet explicitly. This command supports testnet only.');
  return {networkId: 'testnet', nodeUrl: 'https://test.rpc.fastnear.com', helperUrl: 'https://helper.testnet.near.org'};
}
export function deploymentActions(wasm, owner, executor) {
  return [transactions.deployContract(wasm), transactions.functionCall('new', {owner, executor}, 100_000_000_000_000n, 0n)];
}
export function assertInitializedFailure(result) {
  assert.ok(result.status?.Failure, 'Second initialization unexpectedly succeeded');
  assert.match(JSON.stringify(result.status.Failure), /already been initialized/i,
    'Second initialization must fail because state exists, not because of RPC, gas or permissions');
}
function save(name, value) {
  const path = join(directory, name);
  writeFileSync(path + '.tmp', JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  renameSync(path + '.tmp', path);
}
function read(name) { return JSON.parse(readFileSync(join(directory, name), 'utf8')); }
function missing(error) { return /does not exist|doesn't exist|UNKNOWN_ACCOUNT/.test(error.message); }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const config = testnetConfig(process.env.COUNTERSIGN_NETWORK);
  const command = process.argv[2];
  if (!['accounts', 'deploy', 'verify', 'status'].includes(command)) throw Error('Usage: npm run testnet -- accounts|deploy|verify|status');
  process.umask(0o077);
  mkdirSync(directory, {recursive: true, mode: 0o700});
  chmodSync(directory, 0o700);
  const release = await lockfile.lock(directory, {retries: 0});
  try {
    if (!existsSync(join(directory, 'accounts.json'))) {
      if (command !== 'accounts') throw Error('Run accounts first. No accounts or keys were created.');
      const suffix = randomBytes(5).toString('hex');
      save('accounts.json', Object.fromEntries(roles.map(role => [role, `countersign-${role}-${suffix}.testnet`])));
    }
    const accounts = read('accounts.json');
    assert.equal(new Set(Object.values(accounts)).size, 4);
    for (const role of roles) assert.match(accounts[role], /^countersign-[a-z]+-[a-f0-9]{10}\.testnet$/);
    const keyStore = new keyStores.InMemoryKeyStore();
    const near = await connect({...config, keyStore});
    const provider = near.connection.provider;
    assert.equal((await provider.status()).chain_id, 'testnet');
    const state = account_id => provider.query({request_type: 'view_account', account_id, finality: 'final'});
    const view = async method_name => {
      const result = await provider.query({request_type: 'call_function', account_id: accounts.vault,
        method_name, args_base64: 'e30=', finality: 'final'});
      return JSON.parse(Buffer.from(result.result).toString());
    };
    async function signer(role, create = false) {
      const name = `${role}.key.json`;
      if (!existsSync(join(directory, name))) {
        if (!create) throw Error(`Missing ${role} key under work/testnet; refusing replacement`);
        // Refuse to invent a replacement key for an account that already exists.
        try { await state(accounts[role]); throw Error('Account exists but its local key is missing'); }
        catch (error) { if (!missing(error)) throw error; }
        const key = KeyPair.fromRandom('ed25519');
        save(name, {account_id: accounts[role], public_key: key.getPublicKey().toString(), private_key: key.toString()});
      }
      chmodSync(join(directory, name), 0o600);
      const saved = read(name);
      assert.equal(saved.account_id, accounts[role]);
      const key = KeyPair.fromString(saved.private_key);
      assert.equal(key.getPublicKey().toString(), saved.public_key);
      await keyStore.setKey('testnet', accounts[role], key);
      return {account: await near.account(accounts[role]), publicKey: saved.public_key};
    }
    async function recordedTransaction(name, actions) {
      const file = `${name}.json`;
      let record;
      if (existsSync(join(directory, file))) {
        record = read(file);
        assert.equal(record.signer, accounts.vault);
        // Never sign a replacement after an uncertain send. Reconcile its saved hash.
      } else {
        const {account} = await signer('vault');
        const [hash, signed] = await account.signTransaction(accounts.vault, actions);
        record = {hash: utils.serialize.base_encode(hash), signer: accounts.vault};
        save(file, record); // Durable before broadcast; contains no private key.
        await provider.sendTransactionUntil(signed, 'FINAL');
      }
      const outcome = await provider.txStatus(record.hash, accounts.vault, 'FINAL');
      save(file, {...record, outcome});
      return outcome;
    }
    if (command === 'accounts') {
      for (const role of roles) {
        const {publicKey} = await signer(role, true);
        let present = false;
        try { await state(accounts[role]); present = true; } catch (error) { if (!missing(error)) throw error; }
        if (!present) {
          const response = await fetch(`${config.helperUrl}/account`, {
            method: 'POST', headers: {'content-type': 'application/json'},
            body: JSON.stringify({newAccountId: accounts[role], newAccountPublicKey: publicKey}),
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok) throw Error(`Official faucet returned HTTP ${response.status} for ${role}; rerun accounts to reconcile`);
          for (let attempt = 0; ; attempt++) {
            try { await state(accounts[role]); break; }
            catch (error) { if (!missing(error) || attempt >= 30) throw error; await pause(1000); }
          }
        }
        const access = await provider.query({request_type: 'view_access_key', account_id: accounts[role], public_key: publicKey, finality: 'final'});
        assert.equal(access.permission, 'FullAccess');
        console.log(`${role}: ${accounts[role]} (faucet account and local key verified)`);
      }
      return;
    }
    if (command === 'deploy') {
      const wasm = readFileSync(wasmPath);
      const codeHash = utils.serialize.base_encode(createHash('sha256').update(wasm).digest());
      for (const role of roles) await state(accounts[role]);
      if (!existsSync(join(directory, 'deploy.json'))) assert.equal((await state(accounts.vault)).code_hash, emptyCode,
        'Refusing to overwrite existing contract code');
      const outcome = await recordedTransaction('deploy', deploymentActions(wasm, accounts.owner, accounts.executor));
      assert.ok(Object.hasOwn(outcome.status, 'SuccessValue'), 'Atomic deploy/new failed; inspect work/testnet/deploy.json');
      assert.equal((await state(accounts.vault)).code_hash, codeHash, 'Deployed code differs from local WASM');
      console.log(`Atomic deploy/new: ${outcome.transaction.hash}`);
    }
    const controls = await view('get_vault_controls');
    assert.deepEqual(controls, {owner: accounts.owner, executor: accounts.executor, paused: false});
    const available = await view('available_balance');
    assert.match(available, /^\d+$/);
    if (command === 'verify') {
      const before = {controls, available};
      const outcome = await recordedTransaction('reinitialize', [transactions.functionCall('new',
        {owner: accounts.merchant, executor: accounts.merchant}, 100_000_000_000_000n, 0n)]);
      assertInitializedFailure(outcome);
      assert.deepEqual({controls: await view('get_vault_controls'), available: await view('available_balance')}, before);
      save('verification.json', {network: 'testnet', accounts, controls, available_balance: available,
        deploy_transaction: read('deploy.json').hash, reinitialize_transaction: outcome.transaction.hash,
        reinitialize_failure: outcome.status.Failure, verified_at: new Date().toISOString()});
      console.log(`Second new rejected; state unchanged: ${outcome.transaction.hash}`);
    }
    console.log(JSON.stringify({network: 'testnet', accounts, controls, available_balance: available}, null, 2));
    console.log(`https://testnet.nearblocks.io/address/${accounts.vault}`);
  } finally { await release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    // Do not dump objects from signing libraries or local credential files.
    console.error(String(error.message).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/g, '[REDACTED]'));
    process.exitCode = 1;
  });
}
