import {fileURLToPath} from 'node:url';
process.env.NEAR_WORKSPACES_NETWORK='sandbox';
process.env.NEAR_SANDBOX_BIN_PATH=fileURLToPath(new URL('./sandbox-launcher/near-sandbox',import.meta.url));
process.env.NEAR_SANDBOX_BINARY_PATH=fileURLToPath(new URL('./sandbox-launcher/',import.meta.url));
