import {test} from 'node:test';
import assert from 'node:assert/strict';
import {suggestFollowUps,questionForBill} from './public/ask-suggest.js';

test('suggestFollowUps returns [] when the answer has no blocked or failed lines',()=>{
 assert.deepEqual(suggestFollowUps('What is the status of INV-1?','All clear. Nothing to report.'),[]);
 assert.deepEqual(suggestFollowUps('How is my agent doing?',''),[]);
 assert.deepEqual(suggestFollowUps('Why was INV-1 blocked?','[INV-1] beans.near: Paid.'),[]);
});

test('suggestFollowUps returns one chip per blocked or failed line',()=>{
 const answer='[INV-BEANS-003] beans.near: Blocked.\n[INV-2] other.near: Failed.';
 assert.deepEqual(suggestFollowUps('How is my agent doing?',answer),[
  'Why was INV-BEANS-003 blocked?',
  'Why was INV-2 blocked?',
 ]);
});

test('suggestFollowUps never returns more than 3 chips',()=>{
 const answer=['[A-1] x: Blocked.','[A-2] x: Blocked.','[A-3] x: Failed.','[A-4] x: Blocked.'].join('\n');
 assert.deepEqual(suggestFollowUps('How is my agent doing?',answer),[
  'Why was A-1 blocked?','Why was A-2 blocked?','Why was A-3 blocked?',
 ]);
});

test('suggestFollowUps skips the exact question that was just asked',()=>{
 const answer='[INV-9] beans.near: Blocked.\n[INV-8] other.near: Blocked.';
 assert.deepEqual(suggestFollowUps('Why was INV-9 blocked?',answer),['Why was INV-8 blocked?']);
 assert.deepEqual(suggestFollowUps('why was inv-9 blocked?',answer),['Why was INV-8 blocked?']);
});

test('suggestFollowUps ignores paid lines and duplicates',()=>{
 const answer='[P-1] x: Paid.\n[INV-1] x: Blocked.\n[INV-1] x: Failed.';
 assert.deepEqual(suggestFollowUps('How is my agent doing?',answer),['Why was INV-1 blocked?']);
});

test('questionForBill picks the pre-filled question from the bill outcome',()=>{
 assert.equal(questionForBill({id:'INV-BEANS-003',outcome:'blocked'}),'Why was INV-BEANS-003 blocked?');
 assert.equal(questionForBill({id:'INV-BEANS-003',outcome:'failed'}),'Why was INV-BEANS-003 blocked?');
 assert.equal(questionForBill({id:'INV-PAID-1',outcome:'paid'}),'Was INV-PAID-1 paid?');
 assert.equal(questionForBill({id:'INV-Q-1',outcome:'queued'}),'What is the status of INV-Q-1?');
 assert.equal(questionForBill({id:'INV-P-1',outcome:'pending'}),'What is the status of INV-P-1?');
 assert.equal(questionForBill({id:'INV-C-1',outcome:'cancelled'}),'What is the status of INV-C-1?');
});
