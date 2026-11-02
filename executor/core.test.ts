import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Executor, commitment, type Invoice, type Payment, type Rail } from './core.ts';
const invoice: Invoice = { id: 'inv-1', payee: 'merchant.near', asset: 'usdc', amount: '42' };
class Auth {
  p: Payment = { invoice, commitment: commitment(invoice), state: 'Authorized', attempt_id: null };
  async reserve(i: Invoice, a: string) { if (commitment(i) !== this.p.commitment) throw Error('tampered'); if (this.p.attempt_id && this.p.attempt_id !== a) throw Error('duplicate'); this.p = { ...this.p, state: this.p.state === 'Authorized' ? 'Reserved' : this.p.state, attempt_id: a }; return this.p; }
  async resolve(_id: string, a: string, settled: boolean) { if (a !== this.p.attempt_id) throw Error('attempt'); const target = settled ? 'Settled' : 'Failed'; if (this.p.state !== 'Reserved' && this.p.state !== target) throw Error('transition'); this.p.state = target; return this.p; }
}
class MockRail implements Rail { calls = 0; outcome: 'settled' | 'failed' | 'unknown' = 'unknown'; async submit() { this.calls++; throw Error('timeout after possible send'); } async status() { return this.outcome; } }
function setup() { const dir = mkdtempSync(join(tmpdir(), 'countersign-')); const auth = new Auth(), rail = new MockRail(); return { dir, path: join(dir, 'attempts.db'), auth, rail }; }
test('concurrent duplicates, conflicting attempt, and restart never resubmit ambiguous payment', async () => {
 const f = setup(), a = new Executor(f.path, f.auth, f.rail), b = new Executor(f.path, f.auth, f.rail);
 await Promise.all([a.execute(invoice, 'attempt-1'), b.execute(invoice, 'attempt-1')]); assert.equal(f.rail.calls, 1);
 await assert.rejects(() => b.execute(invoice, 'attempt-2')); await assert.rejects(() => b.execute({ ...invoice, amount: '43' }, 'attempt-1'));
 a.close(); b.close(); const restarted = new Executor(f.path, f.auth, f.rail); assert.equal(await restarted.execute(invoice, 'attempt-1'), 'unknown'); assert.equal(f.rail.calls, 1);
 f.rail.outcome = 'settled'; assert.equal(await restarted.reconcile(invoice.id), 'settled'); assert.equal(f.auth.p.state, 'Settled'); restarted.close(); rmSync(f.dir, { recursive: true });
});
test('unauthorized invoice is never submitted and remains blocked', async () => {
 const f = setup(), ex = new Executor(f.path, f.auth, f.rail); await assert.rejects(() => ex.execute({ ...invoice, payee: 'attacker.near' }, 'a')); assert.equal(f.rail.calls, 0); assert.equal(await ex.execute({ ...invoice, payee: 'attacker.near' }, 'a'), 'claimed'); ex.close(); rmSync(f.dir, { recursive: true });
});

test('canonical commitment matches the contract vector', () => {
 assert.equal(commitment(invoice), 'b5561ba22a6b4bfd4d3cc91550e27bf7e5629730521b3f648266008bae0d5506');
 assert.notEqual(commitment({ ...invoice, payee: 'attacker.near' }), commitment(invoice));
 assert.throws(() => commitment({ ...invoice, amount: '042' }));
});

test('unknown status and status errors never trigger another submission', async () => {
 const f = setup(), ex = new Executor(f.path, f.auth, f.rail);
 assert.equal(await ex.execute(invoice, 'a'), 'unknown');
 f.rail.status = async () => { throw Error('status unavailable'); };
 await assert.rejects(() => ex.reconcile(invoice.id));
 assert.equal(await ex.execute(invoice, 'a'), 'unknown');
 assert.equal(f.rail.calls, 1); ex.close(); rmSync(f.dir, { recursive: true });
});

test('confirmed failure is terminal and does not cause automatic retry', async () => {
 const f = setup(), ex = new Executor(f.path, f.auth, f.rail);
 await ex.execute(invoice, 'a'); f.rail.outcome = 'failed';
 assert.equal(await ex.reconcile(invoice.id), 'failed');
 assert.equal(await ex.execute(invoice, 'a'), 'failed');
 await assert.rejects(() => ex.execute(invoice, 'b'));
 assert.equal(f.rail.calls, 1); assert.equal(f.auth.p.state, 'Failed');
 ex.close(); rmSync(f.dir, { recursive: true });
});
