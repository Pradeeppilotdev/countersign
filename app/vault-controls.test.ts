import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readVaultControls,replaceLocalExecutor} from './vault-controls.ts';
test('legacy controls are detected explicitly; RPC outages and invalid results never fall back',async()=>{
 assert.equal(await readVaultControls({view:async()=>{throw Error('MethodResolveError: MethodNotFound');}}),null);
 await assert.rejects(()=>readVaultControls({view:async()=>{throw Error('RPC unavailable');}}),/RPC unavailable/);
 for(const value of [null,{}, {owner:'owner.near',executor:'executor.near',paused:'false'}])await assert.rejects(()=>readVaultControls({view:async()=>value}),/Invalid vault/);
 const expected={owner:'owner.near',executor:'executor.near',paused:true};assert.deepEqual(await readVaultControls({view:async()=>expected}),expected);
});
test('local executor replacement refuses remote RPC before any account/key operation',async()=>{
 const desk={ready(){},worker:{provider:{connection:{url:'https://rpc.mainnet.near.org'}},rootAccount:{accountId:'test.near'}}};
 await assert.rejects(()=>replaceLocalExecutor(desk,'executor-recovery-1'),/local-test-only/);
});
test('executor replacement never funds an account on RPC failure or uses an unknown signing key',async()=>{
 let created=0,changed=0;
 const controls={owner:'owner.test.near',executor:'executor.test.near',paused:true};
 const account={accountView:async():Promise<void>=>{throw Error('RPC unavailable');},getKey:async()=>null};
 const desk={ready(){},vault:{view:async()=>controls},owner:{accountId:controls.owner,call:async()=>{changed++;}},worker:{provider:{connection:{url:'http://127.0.0.1:12345'}},rootAccount:{accountId:'test.near',createSubAccount:async()=>{created++;return account;}},account:()=>account}};
 await assert.rejects(()=>replaceLocalExecutor(desk,'executor-recovery-1'),/RPC unavailable/);
 account.accountView=async()=>{};
 await assert.rejects(()=>replaceLocalExecutor(desk,'executor-recovery-1'),/no saved local signing key/);
 assert.equal(created,0);assert.equal(changed,0);
});
