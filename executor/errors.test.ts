import {test} from 'node:test';
import assert from 'node:assert/strict';
import {callVault,type VaultTransport} from './vault.ts';
test('contract rejections expose bounded reasons while unknown transport outcomes remain errors',async()=>{
 let failure=Error(JSON.stringify({result:{final_execution_status:'FAILURE'},detail:'Smart contract panicked: invoice expired',private:'private-path-and-token'}));
 const transport:VaultTransport={call:async()=>{throw failure;},view:async()=>null};
 await assert.rejects(()=>callVault(transport,'execute',{}),error=>error instanceof Error&&error.message==='invoice expired');
 failure=Error(JSON.stringify({result:{secret:'private-path-and-token'}}));
 await assert.rejects(()=>callVault(transport,'execute',{}),error=>error instanceof Error&&error.message==='Vault request could not be confirmed; reconcile the saved invoice.');
 failure=Error('response lost');await assert.rejects(()=>callVault(transport,'execute',{}),error=>error===failure);
});
