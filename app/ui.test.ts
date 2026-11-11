import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatUnits,
  parseUnits,
  invoiceState,
  paymentActions,
  draftStatus,
  nextInvoiceId,
  filterInvoices,
  createQuoteSelection,
} from "./public/state.js";
import { lockControls, api } from "./public/components.js";

const payment = (id: string, state: string, expired = false) => ({
  id,
  state,
  expired,
  invoice: { amount: "40000000000000000000000" },
});
test("display amounts preserve exact local NEAR and USDC units", () => {
  for (const [value, decimals, expected] of [
    ["1", 24, "0.000000000000000000000001"],
    ["40000000000000000000000", 24, "0.04"],
    ["5000000000000000000000000", 24, "5"],
    ["10000000", 6, "10"],
    ["1", 6, "0.000001"],
  ] as const) {
    assert.equal(formatUnits(value, decimals), expected);
    assert.equal(parseUnits(expected, decimals), value);
  }
  for (const value of ["0", "-1", "NaN", "1e2", "1.0000001", "1,000", " 1", ""])
    assert.throws(() => parseUnits(value, 6));
});
test("recorded invoice terms cannot be authorized again, including after settlement or cancellation", () => {
  for (const state of [
    "Authorized",
    "Reserved",
    "Executing",
    "Settled",
    "Cancelled",
    "Failed",
  ]) {
    const rows = [payment("BILL-1", state)];
    assert.equal(draftStatus("BILL-1", "0.04", rows).disabled, true, state);
    assert.equal(draftStatus("BILL-1", "0.040", rows).tone, "success", state);
    assert.equal(draftStatus("BILL-1", "0.03", rows).tone, "danger", state);
    assert.equal(draftStatus("BILL-2", "0.04", rows).disabled, false, state);
  }
});
test("expired, in-flight and paid invoices offer only the actions their state permits", () => {
  const actions = (state: string, expired = false) =>
    paymentActions(payment("BILL-1", state, expired)).map((a) => a.action);
  assert.deepEqual(actions("Authorized"), ["reserve", "cancel"]);
  assert.deepEqual(actions("Authorized", true), ["cancel"]);
  assert.deepEqual(actions("Reserved"), ["execute"]);
  assert.deepEqual(actions("Reserved", true), ["cancel"]);
  for (const expired of [false, true]) {
    assert.deepEqual(actions("Executing", expired), []);
    assert.equal(
      invoiceState(payment("BILL-1", "Executing", expired)).label,
      "Confirming",
    );
    assert.deepEqual(actions("Settled", expired), ["duplicate"]);
    assert.equal(
      invoiceState(payment("BILL-1", "Settled", expired)).label,
      "Paid",
    );
  }
  assert.deepEqual(actions("Failed"), ["release_failed"]);
  assert.deepEqual(actions("Cancelled"), []);
  assert.deepEqual(actions("unknown"), []);
});
test("invoice search, filters and fresh references use saved payment records", () => {
  const rows = [
    payment("SANDBOX-001", "Settled"),
    payment("SANDBOX-003", "Authorized"),
    payment("MILK-1", "Cancelled"),
  ];
  assert.equal(nextInvoiceId(rows), "SANDBOX-002");
  assert.deepEqual(
    filterInvoices(rows, "sandbox", "paid").map((p) => p.id),
    ["SANDBOX-001"],
  );
  assert.deepEqual(
    filterInvoices(rows, "", "open").map((p) => p.id),
    ["SANDBOX-003"],
  );
  assert.deepEqual(
    filterInvoices(rows, "", "all").map((p) => p.id),
    ["MILK-1", "SANDBOX-003", "SANDBOX-001"],
  );
  assert.equal(rows[0].id, "SANDBOX-001");
});
test("late quote replies cannot reattach a quote after an edit or a different history selection", () => {
  const s = createQuoteSelection(),
    request = s.version();
  s.edit();
  assert.equal(s.accept("old-quote", request), false);
  assert.equal(s.current(), null);
  const next = s.version();
  assert.equal(s.accept("fresh", next), true);
  assert.equal(s.current(), "fresh");
  s.select("saved");
  assert.equal(s.accept("late", next), false);
  assert.equal(s.current(), "saved");
  s.edit();
  assert.equal(s.current(), null);
  assert.equal(s.accept("fresh", next), false);
});
test("finishing a quote request cannot unlock an in-flight payment or a disallowed action", () => {
  const control = (allowed = true) => ({
    disabled: false,
    dataset: { allowed: String(allowed) },
  });
  const pay = [control(), control(false)],
    quote = [control()];
  const scope = (controls: any[]) => ({
    setAttribute() {},
    querySelectorAll() {
      return controls;
    },
  });
  const payments = scope(pay),
    quotes = scope(quote);
  lockControls(payments, true);
  lockControls(quotes, true);
  lockControls(quotes, false);
  assert.deepEqual(
    pay.map((c) => c.disabled),
    [true, true],
  );
  assert.equal(quote[0].disabled, false);
  lockControls(payments, false);
  assert.deepEqual(
    pay.map((c) => c.disabled),
    [false, true],
  );
});
test("the shared request layer reports actionable server errors and connection failures", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Invoice expired." }, { status: 400 }),
  );
  await assert.rejects(
    () => api("/api/sandbox/execute", { id: "OLD" }),
    /Invoice expired/,
  );
  t.mock.method(globalThis, "fetch", async () => {
    throw Error("connection reset");
  });
  await assert.rejects(
    () => api("/api/sandbox"),
    /Refresh|refresh.*before retrying/,
  );
});
