import assert from 'node:assert/strict';
import {createPublicKey, randomBytes} from 'node:crypto';
import {fork} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import lockfile from 'proper-lockfile';
import {signInvoice, publicKeyBase64} from '../merchant/invoice.ts';
import {cafeDirectory, testnetDirectory, readJson, saveJson, success, contractError, evidence, merchantSigningKey, testnetClient} from './testnet-client.mjs';

const unit = 10n ** 24n;
const amount = tenths => (BigInt(tenths) * unit / 10n).toString();
const file = name => join(cafeDirectory, `${name}.json`);
export function cafeInvoices(accounts, key, domain, expiry, suffix) {
  const make = (name, bill, value) => signInvoice({invoice: {id: `daves-${name}-${suffix}`, payee: accounts.merchant, asset: 'near', amount: value},
    merchant_id: 'daves-cafe', bill_id: `daves-${bill}-${suffix}`, vault: accounts.vault, domain, key_version: '1', expires_at: expiry}, key);
  const paid = make('paid', 'bill-001', amount(4));
  const tampered = make('tampered', 'bill-002', amount(1));
  tampered.invoice.payee = accounts.owner; // Preserve original signature deliberately.
  return {paid, tampered, duplicate: make('duplicate', 'bill-001', amount(4)),
    over_budget: make('over-budget', 'bill-003', amount(5)), restart: make('restart', 'bill-004', amount(3))};
}
async function renewUnstartedRestart(client) {
  const plan = readJson(file('plan')), report = readJson(file('report'));
  assert.ok(!report.completed_at && !report.cases.restart && !existsSync(file('killed')), 'Only an unstarted restart case can be renewed');
  for (const name of ['paid', 'tampered', 'duplicate', 'over_budget']) assert.ok(report.cases[name], 'Finish the first four cases before renewal');
  if (plan.transaction_prefixes?.restart === 'restart-renewed') return;
  const original = plan.invoices.restart;
  assert.equal(await client.view('get_payment', {invoice_id: original.invoice.id}), null);
  assert.equal(await client.view('get_invoice_auth', {invoice_id: original.invoice.id}), null);
  assert.ok(!existsSync(join(cafeDirectory, 'transactions', 'restart-reserve.json')));
  const expired = readJson(join(cafeDirectory, 'transactions', 'restart-authorize-signed-invoice.json')).outcome;
  assert.equal(contractError(expired), 'Smart contract panicked: signed invoice expired or excessive lifetime');
  const before = await client.view('policy_snapshot');
  assert.equal(before.usage, amount(4));
  assert.equal(await client.view('available_balance'), amount(16));
  if (!existsSync(file('restart-renewal'))) {
    const {min_payment, ...policy} = plan.policy;
    assert.deepEqual(before.policy, {version: '1', ...policy});
    assert.equal(before.min_payment, min_payment);
    assert.ok(BigInt(before.policy.expires_at) <= BigInt(before.now), 'Renew only after reviewing an expired policy');
    const expires_at = (BigInt(before.now) + 4n * 60n * 60n * 1000n).toString();
    const invoice = {...original.invoice, id: `daves-restart-renewed-${randomBytes(4).toString('hex')}`};
    const signed = signInvoice({...original, invoice, expires_at}, merchantSigningKey(client.accounts));
    saveJson(file('restart-renewal'), {original, signed, before,
      args: {renewal_id: invoice.id, expected_version: before.policy.version, expires_at}});
  }
  const renewal = readJson(file('restart-renewal'));
  const outcome = await client.call('owner', 'restart-renew-policy', 'renew_policy', renewal.args);
  const renewed = success(outcome);
  const after = await client.view('policy_snapshot');
  assert.deepEqual(after.policy, {...renewal.before.policy, version: renewed.version, expires_at: renewal.args.expires_at});
  assert.equal(after.min_payment, renewal.before.min_payment);
  assert.equal(after.usage, renewal.before.usage);
  assert.equal(await client.view('available_balance'), amount(16));
  report.initial_policy ??= report.policy;
  report.policy = {...plan.policy, expires_at: renewal.args.expires_at};
  report.renewal = {outcome: evidence(outcome), before: renewal.before, after, expired_invoice: renewal.original,
    expired_attempt: evidence(expired), reason: 'Original four-hour window elapsed during RPC interruption; same limits and usage preserved'};
  saveJson(file('report'), report);
  plan.policy = report.policy;
  plan.invoices.restart = renewal.signed;
  plan.proposals.restart.arguments.invoice_id = renewal.signed.invoice.id;
  plan.transaction_prefixes = {...plan.transaction_prefixes, restart: 'restart-renewed'};
  saveJson(file('plan'), plan);
  console.log(`Same-policy expiry renewal: ${outcome.transaction.hash}; usage remains 0.4 NEAR`);
}
async function worker(job, crash, onReserved) {
  const child = fork(fileURLToPath(new URL('./testnet-cafe-worker.mjs', import.meta.url)),
    [job, crash ? 'crash-after-reserve' : 'run'], {
      execArgv: ['--disable-warning=ExperimentalWarning'],
      env: {PATH: process.env.PATH, COUNTERSIGN_NETWORK: 'testnet'},
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
  let observed = false, inspectionError;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { inspectionError = Error('Worker timed out; reconcile saved transactions before retrying'); child.kill('SIGKILL'); }, 300_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('message', async message => {
      try {
        assert.ok(crash && message.event === 'reserved' && message.pid === child.pid);
        await onReserved(child.pid);
        observed = true;
      } catch (error) { inspectionError = error; }
      finally { child.kill('SIGKILL'); }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (inspectionError) return reject(inspectionError);
      if (crash ? observed && signal === 'SIGKILL' : code === 0) resolve();
      else reject(Error(`Worker ended unexpectedly: code=${code}, signal=${signal}`));
    });
  });
  return {pid: child.pid, signal: crash ? 'SIGKILL' : null};
}
async function main() {
  process.umask(0o077);
  mkdirSync(cafeDirectory, {recursive: true, mode: 0o700});
  const release = await lockfile.lock(testnetDirectory, {retries: 0});
  try {
    const client = await testnetClient();
    const accounts = client.accounts;
    assert.deepEqual(await client.view('get_vault_controls'), {owner: accounts.owner, executor: accounts.executor, paused: false});
    assert.ok(process.argv.slice(2).every(arg => arg === '--renew-unstarted-restart'), 'Unknown café option');
    if (process.argv.includes('--renew-unstarted-restart')) await renewUnstartedRestart(client);
    if (!existsSync(file('plan'))) {
      assert.equal(await client.view('available_balance'), '0', 'Start only from the Step 1 vault; refuse extra funding');
      assert.equal(await client.view('get_policy'), null);
      assert.equal(await client.view('get_invoice_domain'), null);
      const key = merchantSigningKey(accounts);
      const expiry = (BigInt((await client.view('policy_snapshot')).now) + 4n * 60n * 60n * 1000n).toString();
      const domain = randomBytes(32).toString('hex');
      const invoices = cafeInvoices(accounts, key, domain, expiry, randomBytes(4).toString('hex'));
      saveJson(file('plan'), {accounts, merchant_id: 'daves-cafe', merchant_public_key: publicKeyBase64(createPublicKey(key)), domain,
        policy: {merchants: [{id: 'daves-cafe', payee: accounts.merchant}], per_payment: amount(5), daily_limit: amount(8), min_payment: (unit / 100n).toString(), expires_at: expiry},
        invoices, proposals: Object.fromEntries(['paid', 'restart'].map(job => [job, {name: 'request_payment', arguments: {invoice_id: invoices[job].invoice.id}}]))});
    }
    const plan = readJson(file('plan'));
    assert.deepEqual(plan.accounts, accounts);
    const report = existsSync(file('report')) ? readJson(file('report')) : {network: 'testnet', accounts, live_model_calls: 0, policy: plan.policy, setup: {}, cases: {}};
    const persist = () => saveJson(file('report'), report);
    if (report.completed_at) { console.log(JSON.stringify(report, null, 2)); return; }
    if (!report.setup_complete) {
      const calls = [
        ['fund', 'fund', {}, (2n * unit).toString()],
        ['domain', 'configure_invoice_auth', {domain: plan.domain}, '0'],
        ['merchant-key', 'set_merchant_key', {merchant_id: plan.merchant_id, public_key: plan.merchant_public_key}, '0'],
        ['policy', 'set_policy', plan.policy, '0'],
      ];
      for (const [label, method, args, deposit] of calls) {
        const outcome = await client.call('owner', label, method, args, deposit);
        success(outcome); report.setup[label] = evidence(outcome); persist();
        console.log(`Setup ${label}: ${outcome.transaction.hash}`);
      }
      assert.equal(await client.view('available_balance'), (2n * unit).toString());
      assert.deepEqual(await client.view('get_merchant_key', {merchant_id: plan.merchant_id}), {version: '1', public_key: plan.merchant_public_key});
      const snapshot = await client.view('policy_snapshot');
      const {min_payment, ...policy} = plan.policy;
      assert.deepEqual(snapshot.policy, {version: '1', ...policy});
      assert.equal(snapshot.min_payment, min_payment);
      assert.equal(snapshot.usage, '0');
      report.setup_complete = true; persist();
    }
    const transaction = label => readJson(join(cafeDirectory, 'transactions', `${label}.json`)).outcome;
    async function snapshot(name) {
      if (!existsSync(file(name))) saveJson(file(name), {merchant: await client.balance(), available: await client.view('available_balance'), usage: await client.view('policy_usage')});
      return readJson(file(name));
    }
    async function paymentCase(job, crash = false) {
      if (report.cases[job]) return;
      const signed = plan.invoices[job];
      const prefix = plan.transaction_prefixes?.[job] ?? job;
      const before = await snapshot(`${job}-before`);
      if (crash && !existsSync(file('killed'))) {
        const killed = await worker(job, true, async pid => {
          const payment = await client.view('get_payment', {invoice_id: signed.invoice.id});
          assert.equal(payment.state, 'Reserved');
          assert.equal((await client.balance()).amount, before.merchant.amount);
          assert.ok(!existsSync(join(cafeDirectory, 'transactions', `${prefix}-execute.json`)));
          const db = new DatabaseSync(join(cafeDirectory, 'restart-attempts.db'));
          try {
            const attempt = db.prepare('SELECT * FROM attempts WHERE invoice_id=?').get(signed.invoice.id);
            assert.equal(attempt.state, 'claimed'); assert.equal(attempt.attempt_id, payment.attempt_id);
            saveJson(file('crash-observed'), {pid, payment, attempt, merchant: await client.balance()});
          } finally { db.close(); }
        });
        saveJson(file('killed'), killed);
        console.log(`Executor ${killed.pid} killed with SIGKILL after finalized reserve`);
      }
      const resumed = await worker(job, false);
      const payment = await client.view('get_payment', {invoice_id: signed.invoice.id});
      assert.equal(payment.state, 'Settled');
      const credited = await client.balance();
      assert.equal(BigInt(credited.amount) - BigInt(before.merchant.amount), BigInt(signed.invoice.amount));
      // Submit an actual duplicate execute as well: contract idempotence must prevent a second credit.
      const replay = await client.call('executor', `${prefix}-replay`, 'execute', {invoice_id: signed.invoice.id, attempt_id: payment.attempt_id});
      assert.equal(success(replay).state, 'Settled');
      const afterReplay = await client.balance();
      assert.equal(afterReplay.amount, credited.amount);
      const outcome = transaction(`${prefix}-execute`);
      assert.equal(success(outcome).state, 'Settled');
      report.cases[job] = {outcome: evidence(outcome), result: 'Settled', invoice: signed.invoice,
        authorize: evidence(transaction(`${prefix}-authorize-signed-invoice`)), reserve: evidence(transaction(`${prefix}-reserve`)), replay: evidence(replay),
        merchant_before: before.merchant, merchant_after: credited, merchant_after_replay: afterReplay,
        credited_yocto: signed.invoice.amount, extra_on_replay_yocto: '0',
        ...(crash ? {killed: readJson(file('killed')), observed_before_kill: readJson(file('crash-observed')), resumed_pid: resumed.pid} : {})};
      if (crash) {
        assert.notEqual(resumed.pid, report.cases[job].killed.pid);
        assert.equal(payment.attempt_id, report.cases[job].observed_before_kill.payment.attempt_id);
      }
      persist(); console.log(`${job}: Settled, credited ${signed.invoice.amount} yoctoNEAR once; ${outcome.transaction.hash}`);
    }
    await paymentCase('paid');
    for (const [name, reason] of [['tampered', 'invalid merchant signature'], ['duplicate', 'merchant bill already used'], ['over_budget', 'rolling daily budget exceeded']]) {
      if (report.cases[name]) continue;
      const before = await snapshot(`${name}-before`);
      // Deliberately bypass local invoice validation so the contract performs the rejection.
      const outcome = await client.call('executor', name.replaceAll('_', '-'), 'authorize_signed_invoice', {signed: plan.invoices[name]});
      const error = contractError(outcome);
      assert.equal(error, `Smart contract panicked: ${reason}`);
      assert.equal(await client.view('get_payment', {invoice_id: plan.invoices[name].invoice.id}), null);
      assert.equal((await client.balance()).amount, before.merchant.amount);
      assert.equal(await client.view('available_balance'), before.available);
      assert.equal(await client.view('policy_usage'), before.usage);
      report.cases[name] = {outcome: evidence(outcome), result: error, invoice: plan.invoices[name].invoice, no_payment_record: true, merchant_unchanged: true, usage_unchanged: true};
      persist(); console.log(`${name}: ${error}; ${outcome.transaction.hash}`);
    }
    await paymentCase('restart', true);
    report.final = {available_balance: await client.view('available_balance'), policy_usage: await client.view('policy_usage'), merchant: await client.balance()};
    assert.equal(report.final.available_balance, (13n * unit / 10n).toString());
    assert.equal(report.final.policy_usage, amount(7));
    assert.equal(BigInt(report.final.merchant.amount) - BigInt(report.cases.paid.merchant_before.amount), BigInt(amount(7)));
    report.completed_at = new Date().toISOString(); persist();
    console.log('All five café outcomes verified. Public evidence: work/testnet/cafe/report.json');
  } finally { await release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(String(error.message).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/g, '[REDACTED]')); process.exitCode = 1; });
}
