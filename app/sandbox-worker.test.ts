import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SandboxWorker} from 'near-workspaces';
import {LocalSandboxWorker} from './sandbox-worker.ts';

test('local chain selection skips every Fetch-blocked port in the SDK range',async t=>{
 const ports=[5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080,30301];
 const configs=ports.map(port=>({network:'sandbox' as const,rootAccountId:'test.near',
  port,rpcAddr:`http://127.0.0.1:${port}`,homeDir:`/unused/${port}`,rm:false,refDir:null}));
 let calls=0;
 t.mock.method(SandboxWorker,'defaultConfig',async()=>{
  assert.ok(calls<configs.length,'unexpected extra port selection');
  return configs[calls++];
 });
 const selected=await LocalSandboxWorker.defaultConfig();
 assert.equal(selected,configs.at(-1),'keep the safe SDK configuration intact');
 assert.equal(calls,ports.length);
});

test('available allowed ports are preserved and allocation failures are not retried',async t=>{
 const expected={port:30302,rpcAddr:'http://127.0.0.1:30302'};
 const allocate=t.mock.method(SandboxWorker,'defaultConfig',async()=>expected);
 assert.equal(await LocalSandboxWorker.defaultConfig(),expected);
 assert.equal(allocate.mock.callCount(),1);
 const failure=new Error('port allocation failed');
 allocate.mock.mockImplementation(async()=>{throw failure;});
 await assert.rejects(()=>LocalSandboxWorker.defaultConfig(),error=>error===failure);
 assert.equal(allocate.mock.callCount(),2);
});
