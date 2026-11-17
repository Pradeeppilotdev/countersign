import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SandboxWorker} from 'near-workspaces';
import {SandboxDesk} from '../app/sandbox.ts';

test('a fresh local vault starts even when the SDK first selects blocked RPC ports',{timeout:120000},async t=>{
 // Reproduce Node's rejection without sending any HTTP request on the bad port.
 await assert.rejects(()=>fetch('http://127.0.0.1:6000'),error=>
  error instanceof TypeError&&(error.cause as Error)?.message==='bad port');
 const original=SandboxWorker.defaultConfig.bind(SandboxWorker);
 const badPorts=[6000,6667,10080];let calls=0;
 t.mock.method(SandboxWorker,'defaultConfig',async()=>{
  const config=await original();calls++;
  const port=badPorts.shift();
  return port===undefined?config:{...config,port,rpcAddr:`http://127.0.0.1:${port}`};
 });
 const desk=new SandboxDesk();
 try{
  await desk.start();
  assert.ok(calls>=4,'all forced blocked selections must be skipped before starting');
  const rpc=new URL(desk.worker.provider.connection.url);
  assert.equal(rpc.hostname,'127.0.0.1');assert.equal(rpc.protocol,'http:');
  assert.ok(![6000,6667,10080].includes(Number(rpc.port)));
  const snapshot=await desk.snapshot();
  assert.equal(snapshot.phase,'READY');assert.equal(snapshot.network,'LOCAL_SANDBOX');
  assert.equal(snapshot.available,'5000000000000000000000000');
  assert.equal(snapshot.merchantReceived,'0');
 }finally{await desk.close();}
});
