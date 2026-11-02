import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {prepareRoute,routeCommitment,approveDryRoute} from './approval.ts';
const policy=JSON.parse(readFileSync(new URL('./fixtures/live-policy.json',import.meta.url),'utf8'));
const quote=JSON.parse(readFileSync(new URL('./fixtures/live-dry-quote.json',import.meta.url),'utf8'));
test('route commitment covers every term and vault; stale replay cannot be approved',async()=>{
 const route=prepareRoute('route-1',policy,quote,Date.parse(quote.timestamp));
 const hash=routeCommitment('vault.test.near',route);
 for(const field of Object.keys(route))assert.notEqual(routeCommitment('vault.test.near',{...route,[field]:route[field]+'x'}),hash,field);
 assert.notEqual(routeCommitment('other.test.near',route),hash);
 const reordered=Object.fromEntries(Object.entries(quote).reverse());assert.deepEqual(prepareRoute('route-1',policy,reordered,Date.parse(quote.timestamp)),route);
 const metadata=structuredClone(quote);metadata.untrustedNote='changed';
 assert.notEqual(prepareRoute('route-1',policy,metadata,Date.parse(quote.timestamp)).response_hash,route.response_hash);
 let calls=0;await assert.rejects(()=>approveDryRoute({vault:'vault.test.near',async call(){calls++;},async view(){}},'route-1',policy,quote));assert.equal(calls,0);
});
