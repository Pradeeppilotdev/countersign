import {readFileSync,writeFileSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {compileEvidence} from './replay-evidence.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
export function buildReplay(output=join(root,'work/replay-site')){
  const sources=['docs/attack-results/result.json','docs/testnet-cafe.json','replay/receipt-verification.json'];
  const bytes=sources.map(p=>readFileSync(join(root,p)));
  const evidence=compileEvidence(...bytes.map(b=>JSON.parse(b)));
  evidence.provenance={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),
    sources:sources.map((path,i)=>({path,sha256:createHash('sha256').update(bytes[i]).digest('hex')}))};
  // A closed file list: never package the repository, work/, keys or backend.
  rmSync(output,{recursive:true,force:true});mkdirSync(join(output,'assets'),{recursive:true});mkdirSync(join(output,'evidence'),{recursive:true});
  for(const file of ['index.html','style.css','app.js','model.js'])copyFileSync(join(root,'replay',file),join(output,file));
  copyFileSync(join(root,'app/public/logo.svg'),join(output,'assets/logo.svg'));
  copyFileSync(join(root,'app/public/fonts/manrope.ttf'),join(output,'assets/manrope.ttf'));
  writeFileSync(join(output,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  writeFileSync(join(output,'evidence/weekly.json'),bytes[0]);
  writeFileSync(join(output,'evidence/testnet.json'),JSON.stringify(evidence.cafe,null,2)+'\n');
  writeFileSync(join(output,'evidence/verification.json'),bytes[2]);
  writeFileSync(join(output,'.nojekyll'),'');
  return {output,files:11,evidence};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {output}=buildReplay();console.log(`Recorded demo built: ${output}\nStatic records only. No wallets, payment backend, model keys or new transactions.`);
}
