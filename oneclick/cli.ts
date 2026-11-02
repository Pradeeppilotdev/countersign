import { DryRunWorkflow } from './workflow.ts';
import { readFileSync } from 'node:fs';
import { preview } from './quotes.ts';
import { SimulationTracker } from './tracker.ts';
if (['record','inspect','simulate','replay'].includes(process.argv[2])) {
 const [command,path,id,input] = process.argv.slice(2);
 if (!path || !id) throw Error('Usage: oneclick record|inspect|simulate|replay <database> <id> [input-file]');
 const workflow = new DryRunWorkflow(path);
 try {
  let result;
  if (command === 'record') {
   const policy = JSON.parse(readFileSync(input,'utf8'));
   const quote = await preview(policy);
   result = workflow.save(id,policy,quote.raw);
  } else if (command === 'replay') {
   const policy = JSON.parse(readFileSync(new URL('./fixtures/live-policy.json',import.meta.url),'utf8'));
   const response = JSON.parse(readFileSync(new URL('./fixtures/live-dry-quote.json',import.meta.url),'utf8'));
   result = workflow.save(id,policy,response,'ARCHIVED_REPLAY');
  } else if (command === 'simulate') result = workflow.simulate(id,JSON.parse(readFileSync(input,'utf8')));
  else result = workflow.inspect(id);
  console.log(JSON.stringify(result,null,2));
 } finally {workflow.close();}
} else if (process.argv[2] === 'preview') {
 if (!process.argv[3]) throw Error('Usage: npm run oneclick -- preview policy.json');
 console.log(JSON.stringify(await preview(JSON.parse(readFileSync(process.argv[3],'utf8'))),null,2));
} else if (process.argv[2] === 'demo') {
 const db = new SimulationTracker(process.argv[3] ?? ':memory:');
 try {
  db.register('demo-1','fixture-quote-not-a-live-quote');
  for (const [n,status] of ['PROCESSING','FAILED','SUCCESS'].entries()) {
   console.log(db.observe('demo-1',{quoteHash:'fixture-quote-not-a-live-quote',status,updatedAt:new Date(Date.now()+n*1000).toISOString()}));
  }
 } finally {db.close();}
} else throw Error('Choose preview <policy.json> or demo [sqlite-file]');
