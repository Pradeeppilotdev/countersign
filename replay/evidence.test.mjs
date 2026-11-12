import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,readdirSync,lstatSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compileEvidence,near} from '../scripts/replay-evidence.mjs';
import {buildReplay} from '../scripts/build-replay.mjs';
import {weeklyFrame} from './model.js';
const read=path=>JSON.parse(readFileSync(new URL(path,import.meta.url)));
const inputs=()=>[read('../docs/attack-results/result.json'),read('../docs/testnet-cafe.json'),read('./receipt-verification.json')];
test('recorded weekly checkpoints retain one original payment through crash and repeated selection',()=>{
 const evidence=compileEvidence(...inputs()),before=JSON.stringify(evidence);
 for(let retry=0;retry<3;retry++){
  assert.deepEqual([0,1,2,3].map(i=>weeklyFrame(evidence,i).balance.received),['0.00','0.04','0.04','0.04']);
  assert.equal(weeklyFrame(evidence,2).worker,'Stopped · journal: claimed');
  const last=weeklyFrame(evidence,3);
  assert.equal(last.extra,'0.00');assert.equal(last.bills.filter(b=>b.state==='Settled').length,1);assert.equal(last.bills.filter(b=>b.state==='Blocked').length,1);
  assert.equal(last.attempt,weeklyFrame(evidence,1).attempt);
 }
 assert.equal(JSON.stringify(evidence),before);
 assert.throws(()=>weeklyFrame(evidence,-1));assert.throws(()=>weeklyFrame(evidence,4));
});
test('build refuses contradictory balances, attempts, signed receipts or explorer destinations',()=>{
 const mutations=[
  ([w])=>w.weekly.final.merchantBalance=String(BigInt(w.weekly.final.merchantBalance)+1n),
  ([w])=>w.weekly.finalAttempts.push({...w.weekly.finalAttempts[0]}),
  ([w])=>w.weekly.final.records.find(r=>r.id===w.weekly.winner).auth.payload_hash='changed',
  ([,c])=>c.cases.paid.outcome.link='https://example.com/fake',
  ([,c])=>c.cases.restart.extra_on_replay_yocto='1',
  ([,c])=>c.cases.duplicate.outcome.status={SuccessValue:''},
  ([,,v])=>v.transactions=[],
 ];
 for(const mutate of mutations){const args=inputs();mutate(args);assert.throws(()=>compileEvidence(...args),/Invalid replay evidence/);}
});
test('public testnet evidence is distinct from the local weekly race and carries its real receipts',()=>{
 const e=compileEvidence(...inputs());
 assert.equal(e.mode,'RECORDED_DEMO');assert.equal(e.newPayments,false);assert.equal(e.liveModelCalls,0);
 assert.equal(e.weekly.amount,'0.04');assert.equal(e.cafe.network,'testnet');
 assert.deepEqual(e.cafe.cases.map(c=>c.credited),['0.40','0.00','0.00','0.00','0.30']);
 assert.equal(e.cafe.cases[4].retry,'0.00');assert.ok(e.cafe.cases[4].reserve);
 for(const c of e.cafe.cases)assert.ok(e.verification.transactions.some(v=>v.hash===c.transaction.hash));
 assert.equal(near('1'),'0.000000000000000000000001');assert.throws(()=>near('-1'));
});
test('static artifact contains only allowlisted assets and public evidence; works under a project subpath',t=>{
 const parent=mkdtempSync(join(tmpdir(),'countersign-replay-test-'));t.after(()=>rmSync(parent,{recursive:true,force:true}));
 const {output}=buildReplay(join(parent,'site'));
 const walk=base=>readdirSync(join(output,base)).flatMap(name=>{const p=join(base,name),s=lstatSync(join(output,p));assert.equal(s.isSymbolicLink(),false);return s.isDirectory()?walk(p):[p];});
 assert.deepEqual(walk('').sort(),['.nojekyll','app.js','assets/logo.svg','assets/manrope.ttf','evidence.json','evidence/testnet.json','evidence/verification.json','evidence/weekly.json','index.html','model.js','style.css'].sort());
 const html=readFileSync(join(output,'index.html'),'utf8');
 assert.match(html,/Recorded demo · No new payments/);assert.match(html,/form-action 'none'/);
 for(const [,url] of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g))assert.ok(lstatSync(join(output,url)).isFile());
 assert.doesNotMatch(html,/(?:src|href)="\/(?!\/)/);
 for(const file of walk('').filter(p=>!p.endsWith('.ttf'))){const content=readFileSync(join(output,file),'utf8');assert.doesNotMatch(content,/BEGIN (?:ED25519 |RSA )?PRIVATE KEY|"privateKey"|NEAR_AI_API_KEY/);}
 const js=readFileSync(join(output,'app.js'),'utf8');
 assert.equal([...js.matchAll(/\bfetch\(/g)].length,1);assert.match(js,/fetch\('\.\/evidence.json'\)/);
 assert.doesNotMatch(js,/\/api\/|WebSocket|sendBeacon|localStorage|window\.ethereum|walletSelector/);
});
