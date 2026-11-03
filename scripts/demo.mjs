import {spawn,execFileSync} from 'node:child_process';
import {mkdirSync,appendFileSync,writeFileSync,existsSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const work=join(root,'work');mkdirSync(work,{recursive:true});
const cast=join(work,'demo.cast'),log=join(work,'demo-output.txt');
const began=Date.now();let revision='uncommitted';try{revision=execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim();}catch{}
writeFileSync(log,'',{mode:0o600});writeFileSync(cast,JSON.stringify({version:2,width:120,height:35,timestamp:Math.floor(began/1000),title:'Countersign local verification',env:{TERM:'xterm-256color'}})+'\n',{mode:0o600});
function output(value){const text=String(value);process.stdout.write(text);appendFileSync(log,text);appendFileSync(cast,JSON.stringify([(Date.now()-began)/1000,'o',text.replace(/(?<!\r)\n/g,'\r\n')])+'\n');}
function files(folder){return readdirSync(join(root,folder)).filter(n=>n.endsWith('.test.ts')).map(n=>folder+'/'+n);}
const env={...process.env,NEAR_WORKSPACES_NETWORK:'sandbox',NEAR_SANDBOX_BIN_PATH:join(root,'app/sandbox-launcher/near-sandbox'),NEAR_SANDBOX_BINARY_PATH:join(root,'app/sandbox-launcher')};
// This runner never loads .env or invokes the live-model / live-quote commands.
delete env.NEAR_AI_API_KEY;
async function step(label,cmd,args){
 output('\n=== '+label+' ===\n');
 await new Promise((resolve,reject)=>{
  const child=spawn(cmd,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',output);child.stderr.on('data',output);child.once('error',reject);
  child.once('exit',(code,signal)=>code===0?resolve():reject(Error(label+' failed ('+(signal??code)+')')));
 });
 output('PASS: '+label+'\n');
}
try{
 output('COUNTERSIGN — LOCAL VERIFICATION\nRevision: '+revision+'\nModel proposals: fixture-driven. 1Click: offline signed fixtures. Payments: local test NEAR only.\n');
 if(!existsSync(join(work,'sandbox-bin/near-sandbox')))throw Error('Install NEAR Sandbox 2.14.0 at work/sandbox-bin/near-sandbox first (see README).');
 await step('Build the contract','cargo',['build','--locked','--manifest-path','contract/Cargo.toml','--target','wasm32-unknown-unknown','--release']);
 await step('Agent restrictions, invoice tampering, duplicates and quote validation',process.execPath,['--disable-warning=ExperimentalWarning','--test',...['agent','executor','app','oneclick'].flatMap(files)]);
 await step('Local vault payments, uncertain settlement, owner controls and dry routes',process.execPath,['--disable-warning=ExperimentalWarning','--test','--test-concurrency=1',...files('integration')]);
 await step('Full app crash and chain restart recovery',process.execPath,['--disable-warning=ExperimentalWarning','integration/restart.mjs']);
 output('\nALL CHECKS PASSED. No live model calls, swaps or real funds.\n');
}catch(error){output('\nVERIFICATION FAILED: '+error.message+'\n');process.exitCode=1;}
output('Recording: '+cast+'\nTranscript: '+log+'\n');
