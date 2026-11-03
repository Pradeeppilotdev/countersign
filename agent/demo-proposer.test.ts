import {test} from 'node:test';
import assert from 'node:assert/strict';
import {demoProposer} from './demo-proposer.ts';
const invoice={id:'one',payee:'merchant.test.near',asset:'near',amount:'1'};
test('fixture demos never load credentials and unsupported network/flags fail closed',async()=>{
 let reads=0;const config=()=>{reads++;throw Error('Credentials must not be loaded');};
 const fixture=demoProposer([],config);
 assert.equal(fixture.live,false);
 assert.deepEqual(await fixture.propose(invoice),{name:'request_payment',arguments:{invoice_id:invoice.id}});
 for(const flags of [['--mainnet'],['--live-model','--live-model'],['--live-model','--rpc=https://rpc.mainnet.near.org']])assert.throws(()=>demoProposer(flags,config),/Only --live-model/);
 assert.equal(reads,0);
});
test('live demos require explicit credentials and model without a fixture fallback',()=>{
 assert.throws(()=>demoProposer(['--live-model'],()=>({apiKey:'',model:''})),/Set NEAR_AI/);
 const live=demoProposer(['--live-model'],()=>({apiKey:'test-secret',model:'selected-model'}));
 assert.equal(live.live,true);assert.equal(live.model,'selected-model');
});
