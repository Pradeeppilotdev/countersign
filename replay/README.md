# Recorded Demo café

Visual reference: [Parallel — Finance by Lauri Lännenmäki](https://www.framer.com/marketplace/templates/parallel-finance/). The warm paper, editorial typography and ruled layouts informed this original HTML/CSS presentation. No template code or assets are bundled. The headline receipt uses the verified final result, while the walkthrough below shows each saved checkpoint separately.

The public replay is a static site. Its only request is `GET ./evidence.json`; playback buttons change browser state. It has no wallet connection, payment API, model integration, account creation or owner controls.

`npm run test:replay` → checks the saved balances, single attempt, receipt provenance, browser interactions, failure state and publication allowlist.

`npm run build:replay` → writes only the site assets and curated public records to `work/replay-site/`. Serve that directory with a static HTTP server to preview it. All paths are relative, so both GitHub Pages project paths and a custom domain work.

The builder checks the committed local run in `docs/attack-results/result.json` and the separate testnet café in `docs/testnet-cafe.json`. Testnet receipts were rechecked using read-only archival RPC requests; `receipt-verification.json` records the hashes, final status and check date. Replaying the site never queries RPC. Source hashes and the build commit are included in the public evidence.

The `publish-recorded-demo` job publishes to GitHub Pages only after the full `local-payments` job succeeds on main. It uploads `work/replay-site/`, never the repository or its private runtime files. Publication requires GitHub Pages to use the **GitHub Actions** source. No custom domain or DNS record is changed by this workflow.
