// Preload only in the test CLI. Withhold the successful owner's receipt before
// the caller can write the outcome to the inbox.
import {Account} from 'near-workspaces';

const callRaw = Account.prototype.callRaw;
Account.prototype.callRaw = async function (...args: Parameters<typeof callRaw>) {
 const result = await callRaw.apply(this, args);
 const method=process.env.COUNTERSIGN_TEST_OWNER_RECEIPT ?? 'cancel';
 if (args[1] === method && !result.failed) process.kill(process.pid, 'SIGKILL');
 return result;
};
