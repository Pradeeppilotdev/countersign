import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicError,validateDeskPolicy} from './errors.ts';
import {readFileSync} from 'node:fs';
test('execution rejection is visible without leaking raw internal failures',()=>{
 assert.equal(publicError(Error('receipt: Smart contract panicked: invoice expired')),'Invoice expired.');
 assert.equal(publicError(Error('Cannot read properties of null (secret)')),'Request could not be confirmed. Refresh the invoice state before retrying.');
});
test('desk rejects wrong chains and address formats before requesting a quote',()=>{
 const p=JSON.parse(readFileSync(new URL('../oneclick/fixtures/live-policy.json',import.meta.url),'utf8'));
 validateDeskPolicy(p);
 for(const patch of [{recipient:'attacker.near'},{refundTo:'0xBADADDRESS'},{refundTo:'a..near'},{originAsset:'other'}])assert.throws(()=>validateDeskPolicy({...p,...patch}));
});
