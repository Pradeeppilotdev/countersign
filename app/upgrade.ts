// Explicit local-only upgrade: no initialization, recovery, funding or state reset.
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {upgradeLocalVault} from './vault-upgrade.ts';
const directory=resolve(process.env.COUNTERSIGN_SANDBOX_DIR??fileURLToPath(new URL('../work/local-vault/',import.meta.url)));
try{console.log(JSON.stringify(await upgradeLocalVault(directory),null,2));}
catch(error){console.error(error instanceof Error?error.message:'Local upgrade failed; saved data retained');process.exitCode=1;}
