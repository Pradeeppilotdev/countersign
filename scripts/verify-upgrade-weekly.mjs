// Run from a prepared Countersign checkout. Both revisions, the vault and its backup
// live under a new private directory. The only logic that moves test NEAR is in the pinned project.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const oldCommit = 'aa5efa2547940ee852c2b42c9e5d6c8962db61e5';
const newCommit = 'ba8241315a5f269fb0d84d16c0ae297c8436631b';
const weeklyIds = ['WEEK-A', 'WEEK-B'];
const oldIds = ['OLD-01', 'OLD-02'];
const unit = 10n ** 24n;
const oldAmount = 3n * unit / 100n;
const weeklyAmount = 4n * unit / 100n;
const hash = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
function near(amount) {
  const n = BigInt(amount);
  const fraction = (n % unit).toString().padStart(24, '0').replace(/0+$/, '');
  return (n / unit).toString() + '.' + fraction.padEnd(2, '0');
}
const flags = process.argv.slice(2);
assert.ok(!flags.length || (flags.length === 1 && flags[0] === '--step'), 'Usage: npm run test:upgrade:weekly [-- --step]');
async function advance(prompt) {
  if (!flags.length) return;
  assert.ok(process.stdin.isTTY, 'Use a terminal for --step, or omit the flag for an unattended run.');
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { await input.question('Press Return to ' + prompt + ' … '); }
  finally { input.close(); }
}

const repo = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
const root = mkdtempSync(join(realpathSync(tmpdir()), 'countersign-upgrade-retest-'));
const vaultDir = join(root, 'vault');
const env = { ...process.env, COUNTERSIGN_AGENT_DIR: vaultDir, COUNTERSIGN_SANDBOX_DIR: vaultDir,
  NEAR_AI_API_KEY: '', NEAR_AI_MODEL: '', NEAR_WORKSPACES_NO_LOGS: '1' };
const privateReport = join(root, 'result.json');
const report = { result: 'IN PROGRESS', network: 'LOCAL_SANDBOX', oldCommit, newCommit };
let stage = 'prepare', worker;

function prepareSource(commit) {
  const short = commit.slice(0, 7), src = join(root, short), archive = join(root, short + '.tar');
  mkdirSync(src);
  execFileSync('git', ['archive', '--format=tar', '--output=' + archive, commit], { cwd: repo });
  execFileSync('tar', ['-xf', archive, '-C', src]);
  assert.deepEqual(readFileSync(join(src, 'package-lock.json')), readFileSync(join(repo, 'package-lock.json')),
    'Use a prepared checkout with the package-lock.json from either pinned revision.');
  const binDir = join(src, 'work', 'sandbox-bin');
  mkdirSync(binDir, { recursive: true });
  copyFileSync(join(repo, 'work/sandbox-bin/near-sandbox'), join(binDir, 'near-sandbox'));
  chmodSync(join(binDir, 'near-sandbox'), 0o700);
  console.log('Building the contract from ' + short + ' …');
  // Use distinct build directories, including when a caller already set CARGO_TARGET_DIR.
  execFileSync('cargo', ['build', '--quiet', '--locked', '--manifest-path', 'contract/Cargo.toml',
    '--target', 'wasm32-unknown-unknown', '--release', '--target-dir', join(src, 'contract/target')],
    { cwd: src, env, stdio: 'inherit' });
  const wasm = readFileSync(join(src, 'contract/target/wasm32-unknown-unknown/release/countersign.wasm'));
  const methods = WebAssembly.Module.exports(new WebAssembly.Module(wasm)).map(e => e.name);
  assert.equal(methods.includes('add_weekly_service'), commit === newCommit, 'Unexpected weekly ABI for ' + short);
  return { src, sha: hash(wasm) };
}
function command(build, entry, args = []) {
  const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...args], {
    cwd: build.src, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
  });
  const start = out.search(/^[\[{]/m);
  assert.ok(start >= 0, 'Expected JSON output from ' + entry);
  return JSON.parse(out.slice(start));
}
const desk = (build, ...args) => command(build, 'agent/desk.ts', args);
const merchantTools = build => import(pathToFileURL(join(build.src, 'merchant/invoice.ts')).href);
const cfgPath = join(vaultDir, 'chain.json');
function config() {
  const c = json(cfgPath);
  assert.equal(c.network, 'sandbox'); assert.equal(c.rootAccountId, 'test.near');
  assert.equal(c.homeDir, join(vaultDir, 'chain'));
  assert.ok(Number.isInteger(c.port) && c.port > 1024 && c.port < 65536);
  return c;
}
async function rpc(method, params) {
  assert.ok(['block', 'query'].includes(method), 'Only read-only RPC methods may use this helper.');
  const url = 'http://127.0.0.1:' + config().port;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'retest', method, params }) });
      const reply = await r.json();
      assert.ok(r.ok && !reply.error, JSON.stringify(reply.error));
      return reply.result;
    } catch (error) {
      // The upgrade deliberately stops and restarts the node on the same port.
      if (attempt >= 5 || error.message !== 'fetch failed') throw error;
      await wait(250 * attempt);
    }
  }
}
async function finalized() {
  const head = (await rpc('block', { finality: 'optimistic' })).header.height;
  for (let i = 0; i < 80; i++) {
    const block = (await rpc('block', { finality: 'final' })).header;
    if (block.height >= head) return block;
    await wait(250);
  }
  throw Error('Local block failed to reach finality.');
}
async function snapshot(ids, service) {
  const block = await finalized(), vault = report.vault;
  const query = async args => {
    const result = await rpc('query', { block_id: block.hash, ...args });
    assert.equal(result.block_hash, block.hash);
    return result;
  };
  const view = async (name, args = {}) => {
    const reply = await query({ request_type: 'call_function', account_id: vault, method_name: name,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    return JSON.parse(Buffer.from(reply.result).toString('utf8'));
  };
  const [account, code, available, usage, claim, ...records] = await Promise.all([
    query({ request_type: 'view_account', account_id: report.payee }),
    query({ request_type: 'view_code', account_id: vault }),
    view('available_balance'), view('policy_usage'), service ? view('get_service_claim', { service }) : null,
    ...ids.map(async id => ({ id, payment: await view('get_payment', { invoice_id: id }), auth: await view('get_invoice_auth', { invoice_id: id }) })),
  ]);
  return { height: block.height, vault, chain: config().chainId, codeHash: hash(Buffer.from(code.code_base64, 'base64')),
    merchantBalance: account.amount, available, usage, claim, records };
}
function rows(ids) {
  const db = new DatabaseSync(join(vaultDir, 'inbox.db'), { readOnly: true });
  try {
    const get = db.prepare('SELECT invoice_id, attempt_id, state FROM attempts WHERE invoice_id=?');
    return ids.map(id => get.get(id)).filter(Boolean).map(row => ({ ...row }));
  } finally { db.close(); }
}
function compareFunds(a, b, expected) {
  assert.equal(BigInt(b.merchantBalance) - BigInt(a.merchantBalance), expected, 'merchant balance delta');
  assert.equal(BigInt(a.available) - BigInt(b.available), expected, 'available vault balance delta');
  assert.equal(BigInt(b.usage) - BigInt(a.usage), expected, 'policy usage delta');
}
async function checkpoint(build) {
  const w = fork(join(build.src, 'integration/helpers/weekly-payment-worker.ts'), [vaultDir, ...weeklyIds],
    { cwd: build.src, env, execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  worker = w;
  let diagnostics = '';
  w.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
  return new Promise((resolve, reject) => {
    let transfer, blocked;
    const finish = (error, result) => {
      clearTimeout(timer); w.off('exit', earlyExit); w.off('error', finish); w.off('message', message);
      if (error) reject(error); else resolve(result);
    };
    const earlyExit = code => finish(Error('Worker exited before the crash checkpoint: ' + code + '. ' + diagnostics));
    const message = event => {
      if (event.event === 'transfer_accepted') transfer = event;
      if (event.event === 'duplicate_blocked') blocked = event;
      if (transfer && blocked) finish(null, { winner: transfer.id, loser: blocked.id, attempt: transfer.attempt, reason: blocked.error });
    };
    const timer = setTimeout(() => finish(Error('Timed out waiting for both vault results. ' + diagnostics)), 90000);
    w.once('error', finish); w.once('exit', earlyExit); w.on('message', message);
  });
}
function stopLocal() {
  if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
  if (!existsSync(cfgPath)) return;
  const c = config();
  if (!Number.isSafeInteger(c.pid) || c.pid < 2) return;
  let processName;
  try { processName = execFileSync('ps', ['-p', String(c.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return; }
  if (processName.includes('near-sandbox') && processName.includes(c.homeDir)) {
    try { process.kill(c.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
}
async function run() {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'The retest requires Node 24 or newer.');
  assert.match(execFileSync('rustc', ['--version'], { encoding: 'utf8' }), /^rustc 1\.99\.1\b/, 'Select the project Rust 1.99.1 toolchain.');
  assert.match(execFileSync(join(repo, 'work/sandbox-bin/near-sandbox'), ['--version'], { encoding: 'utf8' }), /\b2\.14\.0\b/);
  assert.ok(existsSync(join(repo, 'node_modules/near-workspaces/package.json')), 'Run npm ci --ignore-scripts in the prepared checkout.');
  // Both lockfiles are checked when the pinned archives are built. The archived
  // app only reads these already-installed modules. No wallets or .env files are copied.
  symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  const old = prepareSource(oldCommit), next = prepareSource(newCommit);
  assert.notEqual(old.sha, next.sha, 'The old and new contracts must be different.');
  report.contractHashes = { before: old.sha, after: next.sha };
  const signing = generateKeyPairSync('ed25519'), oldTools = await merchantTools(old), newTools = await merchantTools(next);
  const merchant = 'local-merchant';
  stage = 'seed signed bills on aa5efa2';
  const init = desk(old, 'init');
  assert.equal(init.network, 'LOCAL_SANDBOX'); assert.match(init.vault, /\.test\.near$/);
  report.vault = init.vault; report.payee = init.merchant;
  const policy = desk(old, 'policy', '0.10', '0.25', '120', '0.001');
  const key = desk(old, 'merchant-key', merchant, oldTools.publicKeyBase64(signing.publicKey));
  assert.equal(key.vault, init.vault);
  function sign(tools, id, bill, cents, service) {
    return tools.signInvoice({ invoice: { id, payee: report.payee, asset: 'near', amount: String(BigInt(cents) * unit / 100n) },
      merchant_id: merchant, bill_id: bill, vault: report.vault, domain: key.domain, key_version: key.version,
      expires_at: String(Math.min(Date.now() + 30 * 60000, Number(policy.expires_at))), ...(service ? { service } : {}) }, signing.privateKey);
  }
  function importBill(build, bill) {
    const path = join(root, bill.invoice.id + '.json');
    writeFileSync(path, JSON.stringify(bill), { flag: 'wx', mode: 0o600 });
    assert.equal(desk(build, 'import', path).state, 'queued');
  }
  const initial = await snapshot(oldIds);
  assert.equal(initial.codeHash, old.sha); assert.equal(initial.available, String(5n * unit));
  for (const [i, id] of oldIds.entries()) {
    importBill(old, sign(oldTools, id, 'LEGACY-BILL-' + (i + 1), i + 1));
    assert.equal(desk(old, 'run', id).state, 'settled');
  }
  const before = await snapshot(oldIds), oldRows = rows(oldIds), oldInbox = desk(old, 'status').invoices;
  compareFunds(initial, before, oldAmount);
  for (const record of before.records) {
    assert.equal(record.payment.state, 'Settled'); assert.ok(record.auth.payload_hash);
    assert.equal(record.payment.attempt_id, oldRows.find(r => r.invoice_id === record.id)?.attempt_id);
  }
  report.beforeUpgrade = before;
  console.log('PASS aa5efa2: ' + before.vault + ' · code ' + before.codeHash.slice(0, 12) + '; merchant +' +
    near(BigInt(before.merchantBalance) - BigInt(initial.merchantBalance)) + '; vault available ' + near(before.available) + '.');
  for (const r of before.records) console.log('  ' + r.id + ' · ' + r.payment.state + ' · ' + near(r.payment.invoice.amount) + ' test NEAR · attempt ' + r.payment.attempt_id);
  await advance('upgrade that same vault to ba82413');

  stage = 'upgrade the same saved vault';
  const upgraded = command(next, 'app/upgrade.ts');
  assert.equal(upgraded.upgraded, true); assert.equal(upgraded.vault, report.vault); assert.equal(upgraded.codeHash, next.sha);
  const after = await snapshot(oldIds);
  assert.equal(after.chain, before.chain); assert.equal(after.codeHash, next.sha);
  compareFunds(before, after, 0n); assert.deepEqual(after.records, before.records);
  assert.deepEqual(rows(oldIds), oldRows); assert.deepEqual(desk(next, 'status').invoices, oldInbox);
  for (const id of oldIds) assert.equal(desk(next, 'run', id).state, 'settled');
  const replay = await snapshot(oldIds);
  compareFunds(after, replay, 0n); assert.deepEqual(replay.records, before.records);
  report.afterUpgrade = after; report.legacyReplayDelta = '0.00';
  console.log('PASS ba82413: ' + after.vault + ' · code ' + after.codeHash.slice(0, 12) + '; vault available ' + near(after.available) +
    '. Old balances, signed receipts and attempt IDs match. Old-bill replay paid ' + near(BigInt(replay.merchantBalance) - BigInt(after.merchantBalance)) + '.');
  await advance('enroll the merchant and race two new signed bills for the same week');

  stage = 'enroll service and race two signed bills';
  const agreement = 'weekly-compute';
  desk(next, 'weekly-service', agreement, merchant, '0.10', '345600000'); // Monday 00:00 UTC.
  const period = desk(next, 'service-status', agreement);
  assert.equal(period.claimed_by, null); assert.equal(period.service.agreement_id, agreement);
  const service = period.service;
  const bills = weeklyIds.map((id, i) => sign(newTools, id, ['WEEKLY-801','WEEKLY-947'][i], 4, service));
  assert.notEqual(bills[0].bill_id, bills[1].bill_id); assert.notEqual(bills[0].signature, bills[1].signature);
  for (const bill of bills) importBill(next, bill);
  const base = await snapshot(weeklyIds, service);
  compareFunds(after, base, 0n); assert.equal(base.claim, null);
  assert.ok(base.records.every(r => r.payment === null && r.auth === null));
  const race = await checkpoint(next);
  assert.deepEqual([race.winner, race.loser].sort(), [...weeklyIds].sort());
  assert.equal(race.reason, 'Service period already claimed by [' + race.winner + '].');
  // This worker is still waiting for the deliberately withheld execute acknowledgement.
  // Independently confirm the actual transfer and durable journal before killing it.
  const paid = await snapshot(weeklyIds, service);
  compareFunds(base, paid, weeklyAmount); assert.equal(paid.claim, race.winner);
  const winning = paid.records.find(r => r.id === race.winner), losing = paid.records.find(r => r.id === race.loser);
  assert.equal(winning.payment.state, 'Settled'); assert.equal(winning.payment.attempt_id, race.attempt);
  assert.equal(winning.payment.invoice.amount, String(weeklyAmount)); assert.equal(losing.payment, null);
  const pendingAttempt = [{ invoice_id: race.winner, attempt_id: race.attempt, state: 'claimed' }];
  assert.deepEqual(rows(weeklyIds), pendingAttempt);
  console.log('Vault settled ' + race.winner + '; ' + race.loser + ' is blocked for agreement ' + agreement +
    ', UTC week starting ' + new Date(Number(service.period_start_ms)).toISOString().slice(0, 10) +
    '. The worker still shows claimed for attempt ' + race.attempt + '.');
  await advance('send SIGKILL to this test payment worker');
  stage = 'crash and retry both weekly bills';
  const exit = once(worker, 'exit');
  assert.ok(worker.kill('SIGKILL'));
  const [code, signal] = await exit; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
  assert.deepEqual(rows(weeklyIds), pendingAttempt);
  console.log('PASS crash: worker exited on SIGKILL after the confirmed transfer; its journal still said claimed.');
  await advance('start fresh workers and retry both invoice IDs');
  const winner = desk(next, 'run', race.winner), loser = desk(next, 'run', race.loser);
  assert.equal(winner.state, 'settled'); assert.equal(loser.state, 'period_claimed'); assert.equal(loser.error, race.reason);
  const final = await snapshot(weeklyIds, service);
  compareFunds(base, final, weeklyAmount); compareFunds(paid, final, 0n);
  assert.equal(final.claim, race.winner); assert.deepEqual(final.records, paid.records);
  const finalAttempts = rows(weeklyIds);
  assert.deepEqual(finalAttempts, [{ invoice_id: race.winner, attempt_id: race.attempt, state: 'settled' }]);
  assert.deepEqual(rows(oldIds), oldRows);
  assert.equal(final.available, String(493n * unit / 100n));
  report.weekly = { service, billIds: bills.map(b => ({ invoice: b.invoice.id, bill: b.bill_id })),
    ...race, signal, stateAtCrash: pendingAttempt[0].state, finalAttempts, base, paid, final,
    merchantDeltaNEAR: near(BigInt(final.merchantBalance) - BigInt(base.merchantBalance)),
    retryDeltaNEAR: near(BigInt(final.merchantBalance) - BigInt(paid.merchantBalance)),
    vaultAvailableNEAR: near(final.available) };
  report.result = 'PASS';
  console.log('PASS weekly: ' + race.winner + ' settled, ' + race.loser + ' was blocked. Weekly merchant +' + report.weekly.merchantDeltaNEAR +
    ', extra on retry ' + report.weekly.retryDeltaNEAR + ', vault available ' + report.weekly.vaultAvailableNEAR + ' local test NEAR.');
}

console.log('Private disposable run: ' + root);
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) process.once(sig, () => { stopLocal(); process.exit(code); });
try { await run(); }
catch (e) {
  report.result = 'FAIL'; report.stage = stage;
  process.exitCode = 1; console.error('FAIL (' + stage + '): ' + e.message);
} finally {
  stopLocal();
  writeFileSync(privateReport, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log('Result file: ' + privateReport);
}
