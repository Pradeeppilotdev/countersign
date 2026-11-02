import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DryRunWorkflow } from './workflow.ts';
const policy=JSON.parse(readFileSync(new URL('./fixtures/live-policy.json',import.meta.url),'utf8'));
const response=JSON.parse(readFileSync(new URL('./fixtures/live-dry-quote.json',import.meta.url),'utf8'));
test('signed quote replay, durable history, idempotence and conflicting policy protection',()=>{
 const dir=mkdtempSync(join(tmpdir(),'countersign-workflow-')), path=join(dir,'demo.db');let w=new DryRunWorkflow(path);
 try {
  assert.throws(()=>w.save('live',policy,response),/deadline|stale/);
  assert.throws(()=>w.inspect('live'),/unknown/);
  const saved=w.save('invoice-1',policy,response,'ARCHIVED_REPLAY');
  assert.equal(saved.fundable,false);assert.equal(saved.expired,true);assert.equal(saved.mode,'ARCHIVED_REPLAY');
  w.save('invoice-1',policy,response,'ARCHIVED_REPLAY');
  assert.throws(()=>w.save('invoice-1',{...policy,maxAmountIn:'3000000'},response,'ARCHIVED_REPLAY'),/already bound/);
  const tampered=structuredClone(response);tampered.quoteRequest.recipient='attacker';
  assert.throws(()=>w.save('bad',policy,tampered,'ARCHIVED_REPLAY'),/signature/);
  w.simulate('invoice-1',{status:'PROCESSING',updatedAt:'2026-11-02T10:00:00Z'});
  w.close();w=new DryRunWorkflow(path);
  assert.equal(w.inspect('invoice-1').simulation.state,'SIMULATED_PROCESSING');
  w.simulate('invoice-1',{status:'FAILED',updatedAt:'2026-11-02T10:01:00Z'});
  const held=w.simulate('invoice-1',{status:'SUCCESS',updatedAt:'2026-11-02T10:02:00Z'});
  assert.equal(held.simulation.state,'NEEDS_REVIEW');assert.equal(held.events.length,3);
 } finally {w.close();rmSync(dir,{recursive:true});}
});
