# Use Countersign from an MCP client

Start with the [local setup](../docs/local-guide.md#quick-start) to install the root dependencies, build the vault and install the local NEAR chain. Then run these commands from the repository root.

```sh
npm ci --prefix mcp --ignore-scripts
npm --prefix mcp run demo:setup
```

The setup starts a fresh local vault and imports two merchant-signed café bills for **0.04 NEAR** each in the same service week. Its owner policy lasts one hour. The command prints the Claude Desktop server entry with absolute paths to Node, the server and that disposable vault.

1. In Claude Desktop, open **Settings → Developer → Edit Config**. Add the printed `countersign` entry under `mcpServers`, preserving your other entries. Restart Claude Desktop. [Local MCP setup](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
2. Ask **“List Dave’s bills, then request payment for CAFE-WEEK-A and CAFE-WEEK-B. Show the outcome of each.”** Approve the local tool calls when prompted. One result has a `Settled` vault receipt with an attempt ID. The other identifies the bill that already claimed the week.
3. Ask **“Retry both bills.”** The paid bill returns the same attempt ID. The other bill still has no transfer.

When finished, stop the disposable chain using the process ID and command printed by setup.

| Tool | What the client receives |
| --- | --- |
| `list_invoices()` | Signed bill IDs, merchant, payee, amount in NEAR, service period and last saved inbox state. This reads the local inbox. |
| `request_payment({invoice_id})` | The existing executor reconciles that bill with the vault. A confirmed receipt includes the state, block hash, attempt ID and signed payload hash. The agent supplies only the ID. |

The server uses standard input and output. Launch it with the Node command printed by setup so standard output carries only MCP messages. Its single configured vault must already exist, and its chain must be running for payment requests. The host holds the executor key. Importing bills, changing policy and correcting a bill are separate owner or intake operations.

## Reproduce the crash

```sh
npm --prefix mcp test
```

The test starts a separate disposable vault, connects using the official MCP client and kills the payment server after the transfer succeeds and before the worker records the result. Two reconnected clients retry both IDs. The test checks the merchant’s balance directly against the local chain, the weekly claim and the saved attempt. Look for `Merchant +0.04 local NEAR; retries +0.00.`
