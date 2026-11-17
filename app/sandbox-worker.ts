import {SandboxWorker} from 'near-workspaces';

// Fetch-blocked ports within near-workspaces' allocation range (5001+).
// https://fetch.spec.whatwg.org/#port-blocking
const blockedRpcPorts=new Set([5060,5061,6000,6566,6665,6666,6667,6668,6669,6679,6697,10080]);

export class LocalSandboxWorker extends SandboxWorker {
 static async defaultConfig(){
  // The SDK calls this while holding its startup lock. Keep its availability
  // checks and advancing allocator, skipping unusable RPC ports before spawn.
  let config=await super.defaultConfig();
  while(blockedRpcPorts.has(config.port))config=await super.defaultConfig();
  return config;
 }
}
