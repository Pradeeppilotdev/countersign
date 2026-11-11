# Countersign

Countersign pays merchant invoices from a NEAR vault. An agent can request payment for an invoice ID. For a supplier enrolled in weekly billing, even two valid signatures can authorize only one payment for the same service week.

## Two signed bills, one payment

1. A merchant signs two different invoices for **0.04 NEAR each** under the same weekly agreement. The agent submits both.
2. The vault settles one bill and blocks the other. We kill the payment worker after the transfer, while its last saved state is still `claimed`.
3. Fresh workers retry both invoices. The merchant has received **0.04 local test NEAR** in total. The retries add **0.00**.

[![Recorded weekly payment. The merchant receives 0.04 local test NEAR and both retries add zero.](docs/demo/weekly-payment-preview.gif)](docs/demo/weekly-payment.mp4?raw=1)

[90-second narrated replay of the terminal run (MP4)](docs/demo/weekly-payment.mp4?raw=1) · [Attack results and recorded balances](docs/attack-results/README.md)

**Try it from an agent.** Connect a local MCP client to a disposable café vault, request both signed bills by ID, and inspect the vault receipt. [MCP setup and crash test](mcp/README.md)

## Quick start

**Run it on GitHub.** Open the *Race two signed bills, crash the worker and retry* step in a verification run. It builds two contract revisions, starts a fresh local NEAR chain and checks the merchant’s balance. To run it yourself without installing tools, fork the repo and choose **Actions → Local payment verification → Run workflow**. A successful run publishes `weekly-payment-result` with the measured balances. [Verification runs](https://github.com/Pradeeppilotdev/countersign/actions/workflows/verify.yml)

**Run it on your computer.** Follow the [local setup](docs/local-guide.md#quick-start) in a full clone, then run this from the repo root.

```sh
npm run test:upgrade:weekly
```

Look for `PASS crash` and `PASS weekly`. Either bill can win. The merchant balance must increase by 0.04 once, with 0.00 extra on retry. The command prints the path to your own `result.json`.

If a supplier corrects a bill before reservation, the owner can transfer that week's claim to the exact signed replacement. Run `npm run test:weekly:correction` after the local build to race a 0.03 correction against the original 0.04 bill and crash the paying worker in each order. [Owner commands](docs/local-guide.md#one-payment-per-service-week)

## What runs

The demo executes native NEAR transfers on a disposable local chain. It uses fixed agent proposals so anyone can reproduce it without a model key. The optional NEAR AI Cloud adapter receives structured invoice fields and can propose only `request_payment({invoice_id})`. The vault checks the merchant signature, payout, spending limits and service week, and records settlement from the transfer callback.

**Hackathon tracks** · AI Security & Defense (primary), Agent Economy (secondary). Built during NEAR HACKATHON with Rust NEAR SDK, TypeScript, Node SQLite, near-workspaces and AI-assisted development. [Official tracks](https://nearhackathon.com/#tracks)

[Local payment desk, contract and operator guide](docs/local-guide.md)

Ask Dave also runs in the desk: open http://127.0.0.1:4317/#ask-dave (needs a local agent vault: npm run agent:desk -- init). Its questions read `work/agent-vault` (or `COUNTERSIGN_AGENT_DIR`), while Payments uses `work/local-vault` (or `COUNTERSIGN_SANDBOX_DIR`). The page and each answer identify the source account. Standalone account checks show their selected network separately; questions always read the local agent vault.
