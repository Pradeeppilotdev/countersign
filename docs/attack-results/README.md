<!-- GitHub and the local payment desk render this same HTML fragment. -->
<h1>Two signed bills for the same service week</h1>

<p class="lead">The merchant signed two different bills for 0.04 NEAR each. Both covered the week of 9 November 2026 (UTC) under the same service agreement. We raced them, killed the payment worker and retried both. The merchant received <strong>0.04 local test NEAR once</strong>.</p>

<table class="balances">
  <thead>
    <tr><th scope="col">Checkpoint on the local chain</th><th scope="col">Vault available (NEAR)</th><th scope="col">Merchant gain since start of race (NEAR)</th></tr>
  </thead>
  <tbody>
    <tr><th scope="row">Before either bill · block 67</th><td>4.97</td><td>+0.00</td></tr>
    <tr><th scope="row">Transfer settled · block 81</th><td>4.93</td><td>+0.04</td></tr>
    <tr><th scope="row">Both bills retried · block 86</th><td>4.93</td><td>+0.04</td></tr>
  </tbody>
</table>

<p><code>WEEK-B</code> (bill <code>WEEKLY-947</code>) claimed the week. The vault blocked <code>WEEK-A</code> (bill <code>WEEKLY-801</code>). At block 81 the vault showed <code>Settled</code>, but the worker was still waiting for its acknowledgement. Its last saved state was <code>claimed</code>.</p>

<p>We killed that worker with <code>SIGKILL</code>. On restart, the winning bill recovered its original payment attempt and the second bill stayed blocked. Retrying added <strong>0.00 NEAR</strong>. The run record includes both bill IDs, the finalized balances and the single settled attempt. <a href="result.json">Inspect the recorded run (JSON)</a>.</p>

<h2>Reproduce the crash and retry</h2>

<p>Complete the <a href="https://github.com/Pradeeppilotdev/countersign#quick-start">local setup</a> in a full Git clone. Run this command from the repository root.</p>

<pre><code>npm run test:upgrade:weekly</code></pre>

<p>The command builds <code>aa5efa2</code> and <code>ba82413</code>, upgrades a disposable vault with two older paid bills, then races the weekly bills. Either can win. Look for <code>PASS crash</code> and <code>PASS weekly</code>, followed by the path to your own <code>result.json</code>. Add <code>-- --step</code> to pause at each checkpoint. <a href="https://github.com/Pradeeppilotdev/countersign/blob/61eb16c/scripts/verify-upgrade-weekly.mjs#L254-L293">Read the balance and attempt checks</a>.</p>

<h2>Other attacks tested</h2>

<table class="attacks">
  <thead>
    <tr><th scope="col">Attempt</th><th scope="col">Observed result</th></tr>
  </thead>
  <tbody>
    <tr><th scope="row">Change the payee</th><td>Even with a fresh merchant signature, redirecting the bill to another account failed the vault’s pinned payout check. <a href="https://github.com/Pradeeppilotdev/countersign/blob/61eb16c/integration/signed-invoice.test.ts#L34-L40">Payout test</a>.</td></tr>
    <tr><th scope="row">Edit a signed amount</th><td>The inbox rejected the edit before saving it. Submitting a changed amount directly to the vault also failed signature verification. <a href="https://github.com/Pradeeppilotdev/countersign/blob/61eb16c/integration/signed-invoice.test.ts#L34-L44">Tampering test</a>.</td></tr>
    <tr><th scope="row">Replay a paid bill</th><td>Running the same invoice twice credited the merchant once. Re-signing the same merchant bill ID under a new invoice ID failed with <code>merchant bill already used</code>. <a href="https://github.com/Pradeeppilotdev/countersign/blob/61eb16c/integration/signed-invoice.test.ts#L61-L69">Replay test</a>.</td></tr>
    <tr><th scope="row">Exceed the rolling budget</th><td>The vault rejected the next proposal. It created no payment record and its recorded usage stayed at the prior amount. <a href="https://github.com/Pradeeppilotdev/countersign/blob/61eb16c/integration/live-policy.test.ts#L53-L60">Budget test</a>.</td></tr>
    <tr><th scope="row">Use a replaced executor</th><td>The old signer lost authority. The replacement finished the existing reservation once. <a href="https://github.com/Pradeeppilotdev/countersign/blob/61eb16c/integration/controls.test.ts#L40-L46">Rotation test</a>.</td></tr>
    <tr><th scope="row">Pay while paused</th><td>The vault rejected authorization, reservation and execution. The merchant balance stayed unchanged. <a href="https://github.com/Pradeeppilotdev/countersign/blob/61eb16c/integration/controls.test.ts#L28-L39">Pause test</a>.</td></tr>
    <tr><th scope="row">Inject a payment instruction</th><td>The agent omitted free-text invoice notes from the model request. Offline model responses that tried to change the amount, merchant or policy triggered zero payment calls. <a href="https://github.com/Pradeeppilotdev/countersign/blob/61eb16c/agent/near-model.test.ts#L6-L15">Input test</a> and <a href="https://github.com/Pradeeppilotdev/countersign/blob/61eb16c/integration/live-policy.test.ts#L30-L37">proposal test</a>.</td></tr>
  </tbody>
</table>

<p>Run <code>npm run demo:verify</code> to repeat these checks with a local NEAR chain and offline model fixtures.</p>
