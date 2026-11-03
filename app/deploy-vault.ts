import {randomUUID} from 'node:crypto';
export async function deployVault(root:any,wasm:string,owner:string,executor:string){
 const vault=await root.createSubAccount('vault-'+randomUUID().slice(0,8));
 // The account exists without code first; deployment and private initialization
 // are actions in ONE transaction signed by that account.
 const tx=await vault.batch(vault).deployContractFile(wasm);
 const result=await tx.functionCall('new',{owner,executor}).transact();
 if(result.failed || result.Failure)throw Error('Atomic vault initialization failed');
 return vault;
}
