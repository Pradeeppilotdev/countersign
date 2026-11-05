// Only fixed contract reasons may escape a transaction error; never echo its JSON.
const reasons=['vault payments paused','pause before replacing executor','merchant signature required','merchant key revoked','merchant key changed; approval invalidated','merchant key version mismatch','invalid merchant signature','merchant bill already used','signed invoice already bound','signed invoice expired or excessive lifetime','signed vault mismatch','signed domain mismatch','no spending policy','merchant not allowed','merchant payout mismatch','per-payment cap exceeded','rolling daily budget exceeded','policy expired','policy revoked','policy changed; approval invalidated','policy history capacity reached','invoice expired','invoice cancelled','insufficient budget','insufficient liquid balance','reservation has not expired','only confirmed failed transfers can be released','only authorized or expired reserved invoices can be cancelled','owner only','executor only','attempt mismatch','invoice mismatch','below policy minimum','invalid policy minimum','pending policy capacity reached','invalid renewal id','renewal id already bound','renewal superseded','policy changed; renewal must be reviewed','renewal expiry must be within 30 days','renewal must extend policy expiry'];
export function vaultReason(error:unknown):string|undefined{
 const message=error instanceof Error?error.message:'';
 return reasons.find(reason=>message.toLowerCase().includes(reason));
}
export function cleanVaultError(error:unknown):unknown{
 const reason=vaultReason(error);if(reason)return Error(reason);
 if(error instanceof Error&&/^\s*\{/.test(error.message))return Error('Vault request could not be confirmed; reconcile the saved invoice.');
 return error; // Unknown transport outcomes retain their exception semantics.
}
