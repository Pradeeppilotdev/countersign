// Fixed plain-English glossary for every reason the vault or the agent can give.
// Written by people, kept in code: the model explains with this text and never
// has to guess what a contract error means. agent/ask.test.ts fails if a reason
// in executor/errors.ts has no entry here.
export type Explanation={meaning:string;what_to_do:string};
const e=(meaning:string,what_to_do:string):Explanation=>({meaning,what_to_do});

// Keys are the lower-case reason text. An error matches the longest key it contains.
export const GLOSSARY:Readonly<Record<string,Explanation>>=Object.freeze({
 // Vault safety switches
 'vault payments paused':e('You paused the vault, so no payment can start or continue until you unpause it.','Unpause the vault when you are ready, then resume the invoice. Nothing was lost.'),
 'pause before replacing executor':e('The agent\'s payment account can only be swapped while the vault is paused, so no payment is caught halfway.','Pause the vault first, replace the agent account, then unpause.'),
 'owner only':e('Only you, the vault owner, may do this. Someone else, such as the agent, tried.','Nothing to do if it was not you. If you meant to do it, run it as the owner.'),
 'executor only':e('Only your agent\'s payment account may do this step. A different account tried.','Nothing to do. Payments must go through the agent.'),

 // Supplier signatures
 'merchant signature required':e('This supplier has a signing key pinned, so the vault only pays invoices the supplier has signed. This one was not signed.','Ask the supplier for a signed invoice. The unsigned one was not paid.'),
 'merchant key revoked':e('You revoked this supplier\'s signing key, so the vault no longer accepts invoices signed with it.','If you still trust the supplier, pin their new key and ask for a freshly signed invoice.'),
 'merchant key changed; approval invalidated':e('The supplier\'s signing key was replaced after this invoice was approved, so the old approval no longer counts.','Ask the supplier to sign the invoice again with their current key.'),
 'merchant key version mismatch':e('The invoice was signed with an older or different key than the one you have pinned for this supplier.','Ask the supplier to sign it with their current key, or check that you pinned the right one.'),
 'invalid merchant signature':e('The invoice does not match what the supplier signed. It was changed after signing, or it was not signed by your supplier at all.','Do not pay it. Check with the supplier through a contact you already trust and ask for a fresh invoice.'),
 'signed invoice differs from the vault authorization':e('The vault approved one signed invoice under this number, and the copy the agent now holds is different.','Do not pay it. Ask the supplier which invoice is the real one.'),
 'signed vault mismatch':e('The invoice was made out to a different vault, not yours.','Ask the supplier for an invoice addressed to your vault.'),
 'signed domain mismatch':e('The invoice was signed for a different vault setup than yours, so the signature cannot be trusted here.','Send the supplier your vault\'s current signing details and ask them to sign again.'),
 'signed invoice expired or excessive lifetime':e('The supplier\'s signature on this invoice has run out, or it was set to last longer than a day, which the vault does not accept.','Ask the supplier for a fresh invoice.'),
 'active merchant key required':e('A weekly service can only be set up for a supplier whose signing key is pinned and active.','Pin the supplier\'s signing key first, then add the weekly service.'),

 // Duplicates and weekly bills
 'merchant bill already used':e('This supplier bill was already paid under another invoice number, so paying it again would be a double payment.','Nothing to do. The duplicate was stopped.'),
 'signed invoice already bound':e('This invoice number is already tied to a different signed bill, so the vault will not swap in a new one.','Nothing to do. If the supplier really sent a new bill, ask them to give it a new invoice number.'),
 'service period already claimed by':e('Another invoice already used this service week. The vault pays one bill per weekly service per week.','Nothing to do. The extra bill for the same week was stopped. If the supplier says it is a different week, ask them to reissue it for that week.'),
 'signed service period required':e('This supplier is on a weekly service, so every bill from them must be signed and name the week it covers. This one did not.','Ask the supplier for a signed bill that states the service week.'),
 'outside current service period':e('The bill names a week that is not the current one: it is either for a past week or a week that has not started.','Ask the supplier to bill for the current week.'),
 'unknown service agreement':e('The bill names a weekly service you have not set up in this vault.','If the service is real, add it as the owner. Otherwise ignore the bill.'),
 'service agreement revoked':e('You cancelled this weekly service, so the vault no longer pays bills for it.','Nothing to do, unless you want the service back. Then set up a new weekly service.'),
 'service agreement already bound':e('A weekly service with this name already exists with different terms, and existing terms cannot be overwritten.','Use a new name for the new terms, or cancel the old service first.'),
 'invalid service agreement id':e('The name given for the weekly service contains characters the vault does not accept.','Use letters, digits, dots, dashes, underscores or colons.'),
 'service payment cap exceeded':e('The bill is larger than the weekly limit you set for this service.','Check the amount with the supplier. If it is right, set up the service with a higher weekly limit.'),
 'invalid service payment cap':e('The weekly limit must be above zero and no larger than your per-payment limit.','Choose a weekly limit within your per-payment limit.'),
 'service merchant or payout mismatch':e('The bill names a weekly service that belongs to a different supplier or pays a different account.','Do not pay it. Check with the supplier.'),
 'service claim mismatch':e('The vault\'s record of which invoice owns this service week does not point to this invoice.','Nothing to do. This invoice will not be paid for that week.'),

 // Spending rules
 'no spending policy':e('You have not set spending rules, or you removed them, so the agent has no permission to pay anything.','Set a spending policy when you want the agent to pay again.'),
 'merchant not allowed':e('This supplier is not on your list of suppliers the agent may pay.','If you trust the supplier, add them to your spending policy. Otherwise nothing to do.'),
 'merchant payout mismatch':e('The invoice asks for the money to go to a different account than the one you pinned for this supplier.','Do not pay it. Confirm the account with the supplier through a contact you already trust.'),
 'per-payment cap exceeded':e('The invoice is larger than the most you allow in a single payment.','Pay it yourself, ask the supplier to split it, or raise your per-payment limit.'),
 'rolling daily budget exceeded':e('Paying this would take the last 24 hours of spending over your daily budget.','Wait until earlier payments are more than 24 hours old and resume it, or raise the daily budget.'),
 'below policy minimum':e('The invoice is smaller than the minimum payment you set, which keeps tiny payments from clogging the vault.','Lower the minimum in your policy if you do want small payments like this.'),
 'invalid policy minimum':e('The minimum payment must be above zero and no larger than your per-payment limit.','Choose a minimum within your per-payment limit.'),
 'policy expired':e('Your spending rules had an end time and it has passed, so the agent may not pay until you renew them.','Renew the policy. Your limits and spending history stay the same.'),
 'policy revoked':e('You removed your spending rules, so approvals made under them no longer count.','Set a new policy if you want the agent to pay again.'),
 'policy changed; approval invalidated':e('You changed your spending rules after this invoice was approved, so the old approval no longer counts.','Run the invoice again so it is checked against your current rules.'),
 'policy history capacity reached':e('The vault keeps a limited record of recent payments for the daily budget, and it is full.','Wait for older payments to pass 24 hours, or clear unused approvals as the owner.'),
 'pending policy capacity reached':e('Too many approved invoices are waiting to be paid at once.','Let the waiting ones finish, or clear approvals you no longer need as the owner.'),
 'insufficient budget':e('The vault does not hold enough unreserved money for this payment.','Add funds to the vault, or wait for held payments to finish.'),
 'insufficient liquid balance':e('The vault account does not have enough spendable NEAR to send this payment right now.','Add funds to the vault.'),

 // Invoice life cycle
 'invoice expired':e('The invoice passed its deadline before it was paid.','Ask the supplier for a fresh invoice.'),
 'invoice cancelled':e('You cancelled this invoice, so it can never be paid.','Nothing to do. If it should be paid after all, ask for a new invoice number.'),
 'invoice mismatch':e('The details sent for payment do not match the invoice the vault approved.','Do not pay it. The approved invoice was not changed.'),
 'attempt mismatch':e('A different payment attempt already holds this invoice, so a second attempt was refused. This prevents paying twice.','Nothing to do. Resume the invoice and the original attempt continues.'),
 'reservation has not expired':e('Money is still held for this invoice, and a hold can only be cancelled after the invoice deadline passes.','Wait for the deadline, then cancel, or let the payment finish.'),
 'only confirmed failed transfers can be released':e('Held money is only handed back once the vault has confirmed the transfer failed. This one is not confirmed as failed.','Resume the invoice so the vault can settle the outcome first.'),
 'only authorized or expired reserved invoices can be cancelled':e('This invoice is too far along to cancel: it is being paid, already paid or already closed.','Nothing to do. Check its current state.'),

 // Policy renewal
 'invalid renewal id':e('The label given for the renewal contains characters the vault does not accept.','Use letters, digits, dots, dashes, underscores or colons.'),
 'renewal id already bound':e('That renewal label was already used for a different renewal.','Use a new label.'),
 'renewal superseded':e('A newer renewal already replaced this one.','Nothing to do. Your policy is on the newer end time.'),
 'policy changed; renewal must be reviewed':e('Your rules changed after this renewal was prepared, so it was not applied blindly.','Look at the current rules and renew again.'),
 'renewal expiry must be within 30 days':e('A policy can be extended by at most 30 days at a time.','Choose an end time within 30 days.'),
 'renewal must extend policy expiry':e('The new end time is not later than the current one, so there is nothing to renew.','Choose a later end time.'),
 'renewal deadline already passed':e('The end time chosen for the renewal is already in the past.','Choose an end time in the future.'),

 // Agent and connection
 'payment outcome pending':e('The payment was sent to the vault but the final result has not been confirmed yet. It is not known to have failed.','Resume the same invoice. The agent picks up the same payment and cannot pay it twice.'),
 'model proposal unavailable or rejected':e('The AI model did not return a usable payment request for this invoice, so nothing was sent to the vault.','Retry the proposal for this invoice. No money moved.'),
 'proposal superseded':e('The agent\'s payment request was replaced while it was being prepared, so the old one was dropped.','Run the invoice again. No money moved.'),
 'service period claim could not be confirmed':e('The vault said this service week was taken, but the agent could not confirm which invoice took it.','Resume the saved invoice so the agent can check again.'),
 'vault request could not be confirmed':e('The agent did not get a clear reply from the vault, so it does not assume the payment went through or failed.','Resume the same invoice. The agent checks the vault before doing anything.'),
 'request could not be confirmed':e('Something went wrong that the vault or agent could not name, and the result is not confirmed.','Check the invoice state, then resume the same invoice.'),
 'vault identity changed':e('The vault the agent was talking to changed while it was working, so it stopped before paying.','Check that the agent points at your vault, then run the invoice again.'),

 // Outcomes the facts pack reports without an error text
 'transfer_failed':e('The vault tried to send the money and the transfer failed on chain. The money did not reach the supplier.','Release the failed payment as the owner to free its budget, then ask for a new invoice if it is still owed.'),
 'payment_in_flight':e('The payment has started on chain and its result is not final yet.','Resume the invoice to let it finish. It cannot be paid twice.'),
 'awaiting_model':e('The agent asked the AI model for a payment request and never got an answer, usually because it was stopped midway.','Retry the proposal for this invoice. No money moved.'),
 'approved_not_sent':e('The vault approved this invoice, but the payment has not been sent yet.','Resume the invoice to send it, or cancel it as the owner.'),
 'invoice_id_taken':e('The vault already holds a different invoice under this invoice number, so this bill was not paid and cannot be paid under that number.','Do not treat it as paid. Ask the supplier to reissue it with a new invoice number.'),
 'not_confirmed_on_chain':e('The agent\'s own notes say this invoice is finished, but the vault does not confirm that.','Trust the vault. Resume the invoice so the agent can re-check it.'),
});

export function explain(error:string|null,reason:string|null=null):Explanation|null{
 const text=(error??'').toLowerCase();
 const key=Object.keys(GLOSSARY).filter(k=>text.includes(k)).sort((a,b)=>b.length-a.length)[0];
 return key?GLOSSARY[key]:reason&&Object.hasOwn(GLOSSARY,reason)?GLOSSARY[reason]:null;
}
