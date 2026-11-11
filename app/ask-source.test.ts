import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {askSource} from './ask-source.ts';
import {askSourceLabels} from './public/ask-source.js';

test('Ask Dave identifies the agent vault separately from the payment desk, without exposing saved data',t=>{
 const root=mkdtempSync(join(tmpdir(),'ask-source-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const agent=join(root,'agent'),payment=join(root,'payment');
 for(const [dir,vault] of [[agent,'agent-vault.test.near'],[payment,'desk-vault.test.near']]){
  mkdirSync(dir);writeFileSync(join(dir,'desk.json'),JSON.stringify({vault,secret:'must not appear',invoices:['private']}));
 }
 assert.deepEqual(askSource(agent,payment,undefined),{
  agentVault:'agent-vault.test.near',paymentVault:'desk-vault.test.near',separate:true,questionNetwork:'local',accountNetwork:'local',
 });
 const same=askSource(agent,agent,'testnet');
 assert.equal(same.separate,false);assert.equal(same.questionNetwork,'local');assert.equal(same.accountNetwork,'testnet');
 for(const network of ['local','sandbox','',undefined])assert.equal(askSource(agent,payment,network).accountNetwork,'local');
 assert.equal(askSource(agent,payment,'mainnet').accountNetwork,'mainnet');
 assert.equal(askSource(agent,payment,'typo').accountNetwork,null);
 assert.equal(JSON.stringify(same).includes('must not appear'),false);
 assert.equal(JSON.stringify(same).includes(root),false);
});

test('a missing or invalid agent identity is never replaced with the payment desk identity',t=>{
 const root=mkdtempSync(join(tmpdir(),'ask-source-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,'desk.json'),JSON.stringify({vault:'desk.test.near'}));
 assert.equal(askSource(join(root,'missing'),root,'local').agentVault,null);
 for(const value of ['not json',JSON.stringify({vault:'<script>bad</script>'}),JSON.stringify({private_key:'hidden'})]){
  writeFileSync(join(root,'desk.json'),value);assert.equal(askSource(root,root,'local').agentVault,null);
 }
});

test('page and answer labels distinguish both vaults and public account lookups',()=>{
 const source={agentVault:'agent.test.near',paymentVault:'desk.test.near',separate:true,questionNetwork:'local',accountNetwork:'local'};
 const local=askSourceLabels(source);
 assert.equal(local.question,'Local agent vault · agent.test.near');
 assert.match(local.detail,/separate local vault: desk.test.near/);
 assert.equal(local.account,'Local agent chain · agent.test.near');
 for(const accountNetwork of ['testnet','mainnet']){
  const remote=askSourceLabels({...source,accountNetwork});
  assert.equal(remote.question,local.question);
  assert.match(remote.account,new RegExp('^'+accountNetwork+' account lookup'));
  assert.ok(!remote.account.includes('Local'));
 }
 assert.match(askSourceLabels({...source,agentVault:null}).question,/not initialized/);
 assert.ok(!askSourceLabels({...source,agentVault:null}).question.includes(source.paymentVault));
 assert.match(askSourceLabels({...source,separate:false}).detail,/same saved vault/);
});
