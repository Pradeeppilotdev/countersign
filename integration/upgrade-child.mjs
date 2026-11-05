// Disposable integration worker. Kill only this worker after a confirmed code
// deployment to exercise recovery from the real interrupted-upgrade boundary.
import {Account} from 'near-workspaces';
import {upgradeLocalVault} from '../app/vault-upgrade.ts';
if(process.argv[4]==='crash'){
 const deploy=Account.prototype.deploy;
 Account.prototype.deploy=async function(...args){const result=await deploy.apply(this,args);process.kill(process.pid,'SIGKILL');return result;};
}
console.log(JSON.stringify(await upgradeLocalVault(process.argv[2],process.argv[3])));
