// Ask Dave acceptance battery: every question in agent/ask/battery.json, one live
// model call each, against the local agent vault. Read-only, like ask "<question>".
// Prints question -> direct (verified reply shown) / facts only / refused / error, with time.
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {askQuestion,REFUSAL} from '../agent/ask/answer.ts';
import {collectFacts} from '../agent/ask/facts.ts';
import {modelConfig,nearChat} from '../agent/ask/model.ts';

if(process.env.ASK_BATTERY!=='1')throw new Error('Set ASK_BATTERY=1 to run the live Ask Dave battery.');

const root=fileURLToPath(new URL('..',import.meta.url));
const directory=process.env.COUNTERSIGN_AGENT_DIR??root+'work/agent-vault/';
const {questions}=JSON.parse(readFileSync(new URL('../agent/ask/battery.json',import.meta.url),'utf8')) as {questions:string[]};
const model=nearChat(modelConfig());
const raw:Record<string,string>={};
let current='';
const complete:typeof model=async messages=>(raw[current]=await model(messages));
const NO_RECORD='No record in this vault answers that question.';
const rows:{q:string;result:string;ms:number;shown:string;why:string}[]=[];
for(const q of questions){
 const start=Date.now();current=q;
 let result:string,shown='',why='';
 try{
  const v=await askQuestion(await collectFacts(directory),q,complete);
  if(!v.ok){result='error';why=v.why;}
  else if(v.text===REFUSAL){result=v.reply_dropped?'refused (chat reply dropped)':'refused';why=v.reply_dropped??'';shown=v.dropped_reply??'';}
  else if(v.text===NO_RECORD)result='no record';
  else if(v.reply_dropped){result='facts only';why=v.reply_dropped;shown=v.dropped_reply??'';}
  else if(v.reply_trimmed){result='direct (trimmed)';shown=v.text.split('\n\n')[0];why=v.reply_trimmed;}
  else if(!v.sources.length&&!v.text.includes('\nSources: ')){result='direct';shown=v.text;}       // small talk
  else if(v.text.includes('\n\n')){result='direct';shown=v.text.split('\n\n')[0];}
  else result='facts only';
 }catch(error){result='error';why=String((error as Error).message??error);}
 rows.push({q,result,ms:Date.now()-start,shown,why});
 console.error(`${rows.length}/${questions.length} ${result} ${((Date.now()-start)/1000).toFixed(1)}s  ${q}`);
}
const cell=(s:string)=>s.replace(/\|/g,'\\|').replace(/\n/g,' ');
console.log('| # | Question | Result | Time | Reply (shown, or dropped) |\n|---|---|---|---|---|');
rows.forEach((r,i)=>console.log(`| ${i+1} | ${cell(r.q)} | ${r.result} | ${(r.ms/1000).toFixed(1)} s | ${cell(r.shown||r.why)} |`));
// The raw model selections, so a dropped reply can be re-checked offline without another model call.
writeFileSync(new URL('../work/ask-battery-last.json',import.meta.url),JSON.stringify(rows.map(r=>({...r,raw:raw[r.q]})),null,1));
const direct=rows.filter(r=>r.result.startsWith('direct')).length;
console.log(`\nAnswered directly: ${direct}/${rows.length}. Median time: ${(rows.map(r=>r.ms).sort((a,b)=>a-b)[Math.floor(rows.length/2)]/1000).toFixed(1)} s.`);
