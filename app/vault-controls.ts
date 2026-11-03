export type VaultControls={owner:string;executor:string;paused:boolean};
export async function readVaultControls(vault:any):Promise<VaultControls|null>{
 let value:any;
 try{value=await vault.view('get_vault_controls',{});}
 catch(error){if(error instanceof Error&&error.message.includes('MethodNotFound'))return null;throw error;}
 const account=(v:any)=>typeof v==='string'&&v.length>=2&&v.length<=64&&/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(v);
 if(!value||!account(value.owner)||!account(value.executor)||typeof value.paused!=='boolean')throw Error('Invalid vault control response');
 return {owner:value.owner,executor:value.executor,paused:value.paused};
}
export async function replaceLocalExecutor(desk:any,label:string){
 desk.ready();
 const rpc=new URL(desk.worker.provider.connection.url);
 if(rpc.protocol!=='http:'||rpc.hostname!=='127.0.0.1'||desk.worker.rootAccount.accountId!=='test.near')throw Error('Executor replacement is local-test-only');
 if(typeof label!=='string'||!/^executor-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label)||label.length>40)throw Error('Use a local account label such as executor-recovery-1');
 const controls=await readVaultControls(desk.vault);
 if(!controls)throw Error('Upgrade the local vault before using emergency controls');
 if(!controls.paused)throw Error('Pause before replacing executor');
 if(controls.owner!==desk.owner.accountId)throw Error('Local owner does not match vault');
 const id=`${label}.test.near`;let account=desk.worker.account(id);
 try{await account.accountView();}
 catch(error){
  // Never turn an unavailable RPC into permission to create/fund another account.
  if(!(error instanceof Error)||(error as Error&{type?:string}).type!=='AccountDoesNotExist')throw error;
  account=await desk.worker.rootAccount.createSubAccount(label,{initialBalance:'1000000000000000000000000'});
 }
 const key=await account.getKey();if(!key)throw Error('Replacement executor has no saved local signing key');
 const access=await account.provider.viewAccessKey(id,key.getPublicKey());
 if(access.permission!=='FullAccess')throw Error('Replacement needs its disposable local full-access key');
 // Same account label is safe to retry after an uncertain rotation response.
 await desk.owner.call(desk.vault,'set_executor',{executor:id});
 const updated=await readVaultControls(desk.vault);
 if(updated?.executor!==id||!updated.paused)throw Error('Executor replacement not confirmed');
 desk.executor=account;desk.persist();return updated;
}
