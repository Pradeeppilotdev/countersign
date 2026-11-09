import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {checkWeeklyUpgradeMethods,storageDigest,storedInvoiceIds,rootAccounts,localRecords,requireUpgradeVerified} from './upgrade-state.ts';
const encode=(s:string)=>Buffer.from(s).toString('base64');
test('only a pinned pre-weekly upgrade can resume without the weekly billing methods',()=>{
 const oldMethods=new Set(['get_payment','get_invoice_auth','authorize_signed_invoice']);
 const legacy=[{key:encode('STATE'),value:encode('old-vault')}];
 assert.doesNotThrow(()=>checkWeeklyUpgradeMethods(oldMethods,legacy));
 assert.throws(()=>checkWeeklyUpgradeMethods(oldMethods),/Missing weekly billing method/);
 for(const prefix of ['weekly-agreements-v1','weekly-claims-v1']){
  const withService=[...legacy,{key:encode(prefix+'compute'),value:encode('claimed-week')}];
  assert.throws(()=>checkWeeklyUpgradeMethods(oldMethods,withService),/Missing weekly billing method/);
 }
});
test('upgrade detects a changed or missing owner renewal intent',()=>{
 const dir=mkdtempSync(join(tmpdir(),'upgrade-renewal-records-'));
 try{
  writeFileSync(join(dir,'desk.json'),'{}');const empty=localRecords(dir);
  mkdirSync(join(dir,'policy-renewals'));const file=join(dir,'policy-renewals/once.json');
  writeFileSync(file,JSON.stringify({state:'pending',request:{renewal_id:'once',expected_version:'1',expires_at:'60000'}}));
  const before=localRecords(dir);assert.notDeepEqual(before,empty);
  writeFileSync(file,JSON.stringify({state:'pending',request:{renewal_id:'once',expected_version:'1',expires_at:'90000'}}));
  assert.notDeepEqual(localRecords(dir),before);
  rmSync(file);assert.notDeepEqual(localRecords(dir),before);assert.deepEqual(localRecords(dir),empty);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('upgrade compares all raw storage, including records outside the UI/inbox',()=>{
 const a=[{key:encode('STATE'),value:encode('owner')},{key:encode('merchant-bills-v1'),value:encode('used-bill')}];
 assert.equal(storageDigest(a),storageDigest([...a].reverse()));
 assert.notEqual(storageDigest(a),storageDigest(a.slice(0,1)));
 assert.notEqual(storageDigest(a),storageDigest([a[0],{...a[1],value:encode('changed-bill')}]));
 assert.throws(()=>storageDigest([...a,a[0]]),/duplicate/);
 const id='unlisted-invoice',key=Buffer.alloc(5+id.length);key[0]=112;key.writeUInt32LE(id.length,1);key.write(id,5);
 assert.deepEqual(storedInvoiceIds([...a,{key:key.toString('base64'),value:encode('payment')}]),[id]);
});
test('upgrade accepts only the supported legacy root layout',()=>{
 const field=(value:string)=>{const b=Buffer.alloc(4+value.length);b.writeUInt32LE(value.length);b.write(value,4);return b;};
 const root=Buffer.concat([field('owner.test.near'),field('executor.test.near'),field('p'),Buffer.alloc(16)]);
 assert.deepEqual(rootAccounts([{key:encode('STATE'),value:root.toString('base64')}]),{owner:'owner.test.near',executor:'executor.test.near'});
 assert.throws(()=>rootAccounts([{key:encode('STATE'),value:root.subarray(0,-1).toString('base64')}]),/layout/);
});
test('local upgrade detects database changes and blocks in-progress inference and unverified startup',()=>{
 const dir=mkdtempSync(join(tmpdir(),'upgrade-records-'));const db=new DatabaseSync(join(dir,'inbox.db'));
 try{
  writeFileSync(join(dir,'desk.json'),'{}');db.exec('CREATE TABLE inbox(id TEXT,state TEXT); CREATE TABLE attempts(invoice_id TEXT,state TEXT);');
  db.prepare('INSERT INTO inbox VALUES(?,?)').run('kept','settled');db.prepare('INSERT INTO attempts VALUES(?,?)').run('kept','settled');
  const before=localRecords(dir);assert.equal(before.databases['inbox.db'].invoices,1);assert.equal(before.databases['inbox.db'].attempts,1);
  db.prepare('UPDATE inbox SET state=?').run('proposal_ready');assert.notDeepEqual(localRecords(dir),before);
  db.prepare('UPDATE inbox SET state=?').run('inference_pending');assert.throws(()=>localRecords(dir),/inference/);
  requireUpgradeVerified(dir);writeFileSync(join(dir,'upgrade-pending.json'),'{}');assert.throws(()=>requireUpgradeVerified(dir),/needs verification/);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
