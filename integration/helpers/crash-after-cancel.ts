// Preload only in the test CLI. The vault has committed the cancellation, but the
// caller cannot receive the response or write the cancellation to the inbox.
import {Account} from 'near-workspaces';

const callRaw = Account.prototype.callRaw;
Account.prototype.callRaw = async function (...args: Parameters<typeof callRaw>) {
 const result = await callRaw.apply(this, args);
 if (args[1] === 'cancel' && !result.failed) process.kill(process.pid, 'SIGKILL');
 return result;
};
