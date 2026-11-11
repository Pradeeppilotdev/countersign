import assert from 'node:assert/strict';
import {join} from 'node:path';
import {InvoicePaymentTool, runInvoiceAgent} from '../agent/payment-tool.ts';
import {cafeDirectory, readJson, saveJson, success, testnetClient} from './testnet-client.mjs';

process.umask(0o077);
try {
  const [job, mode] = process.argv.slice(2);
  assert.ok(['paid', 'restart'].includes(job));
  assert.ok(['run', 'crash-after-reserve'].includes(mode));
  const client = await testnetClient();
  const plan = readJson(join(cafeDirectory, 'plan.json'));
  assert.deepEqual(plan.accounts, client.accounts);
  const signed = plan.invoices[job];
  const prefix = plan.transaction_prefixes?.[job] ?? job;
  const transport = {
    view: (method, args) => client.view(method, args),
    async call(method, args) {
      assert.ok(['authorize_signed_invoice', 'reserve', 'execute'].includes(method));
      const outcome = await client.call('executor', `${prefix}-${method.replaceAll('_', '-')}`, method, args);
      const value = success(outcome);
      if (mode === 'crash-after-reserve' && method === 'reserve') {
        assert.equal(value.state, 'Reserved');
        saveJson(join(cafeDirectory, 'reserve-ready.json'), {pid: process.pid, hash: outcome.transaction.hash, payment: value});
        assert.ok(process.send, 'Crash worker must be supervised over IPC');
        process.send({event: 'reserved', pid: process.pid});
        // The supervisor observes Reserved on chain, then sends a real SIGKILL.
        await new Promise(() => { setInterval(() => {}, 1000); });
      }
      return value;
    },
  };
  const tool = new InvoicePaymentTool(join(cafeDirectory, `${job}-attempts.db`),
    `testnet:${client.accounts.vault}`, signed.invoice, transport, plan.merchant_id, signed);
  // This persisted fixture proposes only the host-assigned invoice ID. No model API call.
  const result = await runInvoiceAgent(signed.invoice, async () => plan.proposals[job], tool);
  assert.equal(result.state, 'settled');
  saveJson(join(cafeDirectory, `${job}-worker-result.json`), {pid: process.pid, result});
} catch (error) {
  console.error(String(error.message).replace(/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/g, '[REDACTED]'));
  process.exitCode = 1;
}
