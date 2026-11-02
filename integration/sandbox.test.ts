import { vaultAdapters } from '../executor/vault.ts';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Worker } from 'near-workspaces';
import { Executor, commitment } from '../executor/core.ts';

test('vault enforces authorization, budget, transfer and replay protection', { timeout: 120_000 }, async () => {
 const worker = await Worker.init();
 try {
  const root = worker.rootAccount;
  const owner = await root.createSubAccount('owner');
  const executor = await root.createSubAccount('executor');
  const attacker = await root.createSubAccount('attacker');
  const merchant = await root.createSubAccount('merchant');
  const contract = await root.devDeploy('contract/target/wasm32-unknown-unknown/release/countersign.wasm');
  await contract.call(contract, 'new', { owner: owner.accountId, executor: executor.accountId });
  await owner.call(contract, 'fund', {}, { attachedDeposit: '1000000000000000000000000' });
  const invoice = { id: 'invoice-1', payee: merchant.accountId, asset: 'near', amount: '600000000000000000000000' };
  await assert.rejects(() => attacker.call(contract, 'authorize', { invoice }));
  await owner.call(contract, 'authorize', { invoice });
  assert.equal(await contract.view('invoice_commitment', { invoice }), commitment(invoice));
  await assert.rejects(() => attacker.call(contract, 'reserve', { invoice, attempt_id: 'a' }));
  await assert.rejects(() => executor.call(contract, 'reserve', { invoice: { ...invoice, payee: attacker.accountId }, attempt_id: 'a' }));
  await executor.call(contract, 'reserve', { invoice, attempt_id: 'a' });
  await executor.call(contract, 'reserve', { invoice, attempt_id: 'a' });
  assert.equal(await contract.view('available_balance', {}), '400000000000000000000000');
  await owner.call(contract, 'authorize', { invoice: { ...invoice, id: 'invoice-2' } });
  await assert.rejects(() => executor.call(contract, 'reserve', { invoice: { ...invoice, id: 'invoice-2' }, attempt_id: 'b' }));
  await assert.rejects(() => attacker.call(contract, 'execute', { invoice_id: invoice.id, attempt_id: 'a' }));
  await assert.rejects(() => executor.call(contract, 'on_transfer', { invoice_id: invoice.id, attempt_id: 'a' }));
  const before = BigInt((await merchant.balance()).total.toString());
  const { auth, rail } = vaultAdapters({
   call: (method, args) => executor.call(contract, method, args, { gas: '100000000000000' }),
   view: (method, args) => contract.view(method, args),
  }, invoice.id);
  const coordinator = new Executor(':memory:', auth, rail);
  try { assert.equal(await coordinator.execute(invoice, 'a'), 'settled'); }
  finally { coordinator.close(); }
  assert.equal((await contract.view<any>('get_payment', { invoice_id: invoice.id })).state, 'Settled');
  assert.equal(BigInt((await merchant.balance()).total.toString()) - before, BigInt(invoice.amount));
  await executor.call(contract, 'execute', { invoice_id: invoice.id, attempt_id: 'a' });
  assert.equal(BigInt((await merchant.balance()).total.toString()) - before, BigInt(invoice.amount));
  await assert.rejects(() => executor.call(contract, 'execute', { invoice_id: invoice.id, attempt_id: 'other' }));
  const failed = { ...invoice, id: 'missing-payee', payee: 'missing-account.test.near', amount: '1' };
  await owner.call(contract, 'authorize', { invoice: failed });
  await executor.call(contract, 'reserve', { invoice: failed, attempt_id: 'failure' });
  await executor.call(contract, 'execute', { invoice_id: failed.id, attempt_id: 'failure' }, { gas: '100000000000000' });
  assert.equal((await contract.view<any>('get_payment', { invoice_id: failed.id })).state, 'Failed');
  await executor.call(contract, 'execute', { invoice_id: failed.id, attempt_id: 'failure' });
  assert.equal(await contract.view('available_balance', {}), '399999999999999999999999');
 } finally { await worker.tearDown(); }
});
