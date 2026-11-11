import {McpServer} from '@modelcontextprotocol/server';
import {serveStdio} from '@modelcontextprotocol/server/stdio';
import {z} from 'zod';
import {publicError} from '../app/errors.ts';
import {listInvoices, LocalDeskError, readTarget, requestPayment, restrictRpc} from './local-vault.ts';

function message(error: unknown) {
  return error instanceof LocalDeskError ? error.message : publicError(error);
}
function failure(error: unknown) {
  return {isError: true, content: [{type: 'text' as const, text: message(error)}]};
}
function result(data: Record<string, unknown>, isError = false) {
  return {isError, structuredContent: data, content: [{type: 'text' as const, text: JSON.stringify(data)}]};
}

try {
  const target = readTarget(process.env.COUNTERSIGN_AGENT_DIR);
  restrictRpc(target);
  serveStdio(() => {
    const server = new McpServer({name: 'countersign', version: '0.1.0'});
    server.registerTool('list_invoices', {
      description: 'List merchant-signed bills in the selected local test vault inbox. Amounts are in NEAR. inbox_state is the last saved worker state.',
      inputSchema: z.strictObject({}),
      annotations: {readOnlyHint: true, openWorldHint: false},
    }, () => {
      try { return result(listInvoices(target)); } catch (error) { return failure(error); }
    });
    server.registerTool('request_payment', {
      description: 'Request or reconcile one existing signed bill by ID using local test NEAR. The vault enforces its policy. Only a Settled vault receipt confirms payment. Retry the same ID after interruption.',
      inputSchema: z.strictObject({invoice_id: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)}),
      annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
    }, async ({invoice_id}) => {
      try {
        const payment = await requestPayment(target, invoice_id);
        return result(payment, ['period_claimed', 'failed', 'cancelled'].includes(payment.inbox_state));
      } catch (error) { return failure(error); }
    });
    return server;
  });
} catch (error) {
  console.error(message(error));
  process.exitCode = 1;
}
