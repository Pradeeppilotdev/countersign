# 1Click dry-run integration

This module cannot move funds. Its only HTTP operation is POST to the fixed official `/v0/quote` endpoint with `dry: true`. Redirects are disabled and requests time out after 15 seconds. There are no deposit, signed-intent or payment-execution methods. A separate local owner transport records a non-fundable dry route commitment in the NEAR vault; it cannot execute that route as a native payment.

## Run → observe

- `npm run test:oneclick` → offline tests pass for terms enforcement, cryptographic tampering, dry-only HTTP behavior, persistent simulation and approval recovery.
- `npm run oneclick -- demo` → PROCESSING followed by FAILED and then SUCCESS remains NEEDS_REVIEW. Output is explicitly simulated.
- `npm run oneclick -- demo ./simulation.db` → same demo with durable local SQLite history. Use a fresh database for a fresh demo. Never treat these records as payment evidence.
- Create a local owner-approved policy JSON using the fields below; run `npm run oneclick -- preview /absolute/path/policy.json` → requests a real dry quote, verifies the official SDK signature, validates policy constraints, and prints `mode: DRY_RUN`, `fundable: false`, the quote hash and expiry. Network errors, unsupported/default fields or invalid quotes fail closed. Live verification succeeded on 2026-11-02 at 09:58:53 UTC (15:28:53 India time): 1.002555 USDC on NEAR quoted for exactly 1 USDC on Base. Signature and all policy checks passed; no deposit address was returned. This expired quote is evidence of verification, not a current price.

Policy fields (all strings): `originAsset`, `destinationAsset`, `recipient`, `refundTo`, `amountOut`, `maxAmountIn`, `deadline`. Use exact asset identifiers from 1Click's supported-token list; amounts are positive integer base units, not display decimals. Deadline must be a valid ISO date in the next hour. Recipient/refund addresses must be approved independently; this module checks exact matching but does not verify ownership, address-chain correctness or merchant legitimacy. Do not let the untrusted agent set its own policy. The public quote request discloses these route fields to 1Click.

## Quote checks and trust

Requests are EXACT_OUTPUT with zero slippage and external-chain deposit/refund/recipient modes. Validation requires identical echoed policy fields, amountIn within the cap, amountOut equal to the invoice, minAmountOut sufficient to pay it, and a signed timestamp no older than 60 seconds (5 seconds future-clock tolerance). The request deadline is also enforced. Quotes expire at the earlier of that deadline and the freshness limit. A dry preview is never executable authorization, even before expiry.

The pinned official SDK's `verifyQuoteSignature` verifies against its default 1Click manager key. No caller-provided verification key is accepted by the application. Tests use a temporary test signer solely to verify the SDK's cryptographic behavior and confirm production validation rejects that signer. `validateTerms` is a testable policy helper; it alone does not authenticate a quote. Call `validateQuote` or `preview` for authenticated validation.

Inspection of the SDK shows optional fields such as appFees and depositMode are excluded from its signed request projection. Our request does not use these features. Validation accepts only observed server defaults (SIMPLE deposit mode, public confidentiality, zero quote wait, uninsured) and exactly one required appFees entry for the pinned observed provider recipient at 1 basis point; missing or empty appFees is rejected. Arbitrary fee recipients, higher rates and multiple fees are rejected. Fee recipients and amounts in that metadata are NOT authenticated by the SDK and are NOT included as trusted amounts. The validation result explicitly lists appFees, timeEstimate, refundFee and withdrawFee as unsigned metadata; their provider values are excluded from the trusted summary. Raw responses retain these values only with an explicit untrusted-metadata notice. Signed total input and output amounts still enforce the spending cap and invoice requirement. Other extra fields fail closed. Dry quotes must not contain execution addresses/memos. This intentionally narrow schema may reject legitimate API responses that include new/default optional fields; review their semantics and signature coverage before expanding it.

## Settlement tracking scope

1Click dry quotes do not create a deposit address or swap. Consequently this release uses **local simulated observations**, not live settlement polling. `SimulationTracker` binds a simulation ID immutably to a quote hash, stores events and state in SQLite, ignores stale/duplicate timestamps, and preserves state across restart. SUCCESS and REFUNDED are separate simulated provider outcomes, not independent on-chain proof. FAILED, unknown statuses, incomplete deposits and contradictory terminal observations become NEEDS_REVIEW. That hold never automatically clears or triggers a retry. There is no mechanism that releases actual funds or updates the vault.

Next integration requires a separately approved non-dry quote with authenticated deposit address/memo, persisted binding, read-only `/v0/status` polling, freshness/conflict handling and verification of settlement/refund evidence. The signature on the embedded original quote must not be mistaken for a signature over the entire status response. Never infer that timeout/404/FAILED means no money moved.

## Official references reviewed

- [Quote API and dry semantics](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote)
- [Signature verification](https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature)
- [Status API](https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status)

## Live verification fixture

`fixtures/live-dry-quote.json` is an authentic signed API response; `fixtures/live-policy.json` records its policy. Tests validate at the captured timestamp and separately reject it when stale. The recipient `0x1111111111111111111111111111111111111111` and refund account `wrap.near` were public example inputs, not team-controlled destinations, and must never be used for a funded payment. The nonexistent example refund account initially returned HTTP 400 with a generic server error; using an existing example account yielded a quote. Zero slippage and the original one-USDC amount worked unchanged.

To repeat the dry check, copy the fixture policy to a local file, set a fresh deadline within one hour, and run the preview command. This discloses only example route data. No API key was needed in this check.

## Connected implementation: persistent quote-to-simulation workflow

Run these from the project root for an offline demonstration using the authentic, archived signed quote:

```sh
npm run oneclick -- replay ./demo.db invoice-1
npm run oneclick -- simulate ./demo.db invoice-1 oneclick/fixtures/simulated-processing.json
npm run oneclick -- inspect ./demo.db invoice-1
```

You should see `ARCHIVED_REPLAY`, `fundable: false`, `expired: true`, a stable policy/quote binding and `SIMULATED_PROCESSING`. The inspect command works in a new process and includes persisted event history. The replay validates the historical signature and terms at capture time; it does not make the quote fresh or executable.

For a fresh live preview with an owner-approved policy file and current deadline:

```sh
npm run oneclick -- record ./previews.db invoice-2 /absolute/path/policy.json
npm run oneclick -- inspect ./previews.db invoice-2
```

`record` only calls the dry quote endpoint and stores the result after signature/policy validation. A new quote requires a new workflow ID; existing IDs cannot be rebound to changed policy terms or quotes. These workflow IDs are simulation records, not vault payment authorizations. Policy, signed raw response, validation, timestamps and observations persist in SQLite. Local database files are gitignored; protect them because they contain route/policy data.

`simulate` reads a JSON file with `status` and ISO `updatedAt`. This input is explicitly a local simulation, not an authenticated provider status. FAILED or unknown outcomes hold for review, and later SUCCESS does not clear that hold. These simulation commands never fund, sign, submit or update the vault.

## Durable local approval recovery

`npm run oneclick:approve:live` → request a fresh signed dry quote, approve its exact commitment on a new local vault, reopen the SQLite records and recover the approval through read-only `get_route`. The command also rejects a modified refund destination and verifies unchanged balances. This full check passed on 3 November 2026 (India time); `work/live-route-approval.json` contains local evidence. It is not a live swap or settlement check.

`DryRunWorkflow.approve` saves the vault, route and commitment atomically before the owner call. Concurrent callers and restarted processes never submit another approval for that workflow ID. `reconcileApproval(id, {vault, view})` requires only read access. A missing record or unavailable RPC leaves an unconfirmed attempt `UNKNOWN`; a mismatched commitment creates a persistent `NEEDS_REVIEW` hold. Neither outcome enables retries. Exact chain evidence yields `APPROVED`, still with `fundable: false`. Recovery after expiry proves only the historical approval and reports `expired: true`.

`npm run oneclick -- inspect work/live-route-approval.db <invoice-id>` → see the persisted approval alongside the separately labelled settlement simulation. The live demo's vault is disposable and closes afterward; continuous recovery requires retaining the same local chain and supplying its trusted read transport. Dry quotes have no deposit address, so real settlement polling remains outside this dry-run flow.
