import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import {parseNear,SandboxDesk} from './sandbox.ts';
test('sandbox amounts use exact base units and reject invalid values',()=>{
 assert.equal(parseNear('0.1'),'100000000000000000000000');
 assert.equal(parseNear('0.000000000000000000000001'),'1');
 for(const bad of ['0','-1','5.1','1e2','NaN','0.0000000000000000000000001',1,null])assert.throws(()=>parseNear(bad));
});
test('sandbox refuses payment actions before local initialization',async()=>{
 const desk=new SandboxDesk();await assert.rejects(()=>desk.action('execute',{id:'invoice'}),/Start the local sandbox/);
 assert.equal((await desk.snapshot()).network,'LOCAL_SANDBOX');
});
