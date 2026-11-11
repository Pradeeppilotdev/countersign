import {generateKeyPairSync, randomBytes} from 'node:crypto';
import {mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {AgentInbox} from '../agent/inbox.ts';
import {SandboxDesk, parseNear} from '../app/sandbox.ts';
import {publicKeyBase64, signInvoice} from '../merchant/invoice.ts';

export async function prepareDemo() {
  const directory = mkdtempSync(join(tmpdir(), 'countersign-mcp-'));
  const desk = new SandboxDesk(directory, {recoverOnStart: false});
  let inbox: AgentInbox | undefined;
  try {
    await desk.start();
    const {vault, merchant, owner} = desk;
    const key = generateKeyPairSync('ed25519'), domain = randomBytes(32).toString('hex');
    const merchant_id = 'daves-cafe', agreement_id = 'weekly-coffee';
    const now = BigInt((await vault.view('policy_snapshot', {})).now);
    const expires_at = String(now + 3_600_000n);
    await owner.call(vault, 'set_policy', {merchants: [{id: merchant_id, payee: merchant.accountId}],
      per_payment: parseNear('0.04'), daily_limit: parseNear('0.08'), expires_at});
    await owner.call(vault, 'configure_invoice_auth', {domain});
    const registered = await owner.call(vault, 'set_merchant_key', {merchant_id, public_key: publicKeyBase64(key.publicKey)});
    await owner.call(vault, 'add_weekly_service', {agreement_id, merchant_id, anchor_ms: String(now), cap: parseNear('0.04')});
    const service = await vault.view('current_service_period', {agreement_id});
    inbox = new AgentInbox(join(directory, 'inbox.db'), desk.session + ':' + vault.accountId, {
      view: (method, args) => vault.view(method, args),
      call: async () => { throw Error('Demo intake can only verify signatures.'); },
    });
    for (const id of ['CAFE-WEEK-A', 'CAFE-WEEK-B']) {
      const invoice = {id, payee: merchant.accountId, asset: 'near', amount: parseNear('0.04')};
      const signed = signInvoice({invoice, merchant_id, bill_id: 'bill-' + id, vault: vault.accountId, domain,
        key_version: registered.version, expires_at, service}, key.privateKey);
      await inbox.enqueueSigned(signed, vault.accountId);
    }
    return {directory, vault: vault.accountId, merchant: merchant.accountId, service};
  } catch (error) {
    // Only this command's newly created disposable chain belongs to the fixture.
    try { process.kill(JSON.parse(readFileSync(join(directory, 'chain.json'), 'utf8')).pid, 'SIGTERM'); } catch {}
    throw error;
  } finally { inbox?.close(); await desk.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const demo = await prepareDemo();
  const {pid} = JSON.parse(readFileSync(join(demo.directory, 'chain.json'), 'utf8'));
  console.log('Two signed 0.04 NEAR bills are ready in a disposable local vault. The policy lasts one hour.');
  console.log(`When finished, check that "ps -p ${pid} -o command=" names this demo directory, then stop its local chain with "kill ${pid}".`);
  console.log('Add this server entry to your Claude Desktop configuration.');
  console.log(JSON.stringify({mcpServers: {countersign: {command: process.execPath,
    args: [fileURLToPath(new URL('./server.ts', import.meta.url))], env: {COUNTERSIGN_AGENT_DIR: demo.directory}}}}, null, 2));
}
