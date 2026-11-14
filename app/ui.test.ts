import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatUnits,
  parseUnits,
  cafeBudgetSpent,
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

test("café budget note follows the vault's rolling remaining figure", () => {
  const policy = { min_payment_near: "0.005" };
  const spending = (remaining_near) => ({ remaining_near });
  const queued = { outcome: "queued", amount_near: "0.4" };
  assert.equal(cafeBudgetSpent(spending("1.2"), [queued], policy), false);
  assert.equal(cafeBudgetSpent(spending("0.4"), [queued], policy), false);
  assert.equal(cafeBudgetSpent(spending("0.3"), [queued], policy), true);
  assert.equal(cafeBudgetSpent(spending("0"), [], policy), true);
  assert.equal(cafeBudgetSpent(spending("0.3"), [{ outcome: "blocked", amount_near: "0.4" }], policy), false);
  assert.equal(cafeBudgetSpent(null, [queued], policy), false);
  assert.equal(cafeBudgetSpent(spending(null), [], policy), false);
});

// --- Demo world: chapter routing and the separate shell -------------------
import { readFileSync } from "node:fs";
import { CHAPTERS, demoRoute, applyDemoWorld, landingHash } from "./public/demo-world.js";

test("the bare URL opens Agent payments on every network", () => {
  assert.equal(landingHash(""), "#agent-payments");
  assert.equal(demoRoute(landingHash("")), null);
  assert.equal(landingHash("#demo"), "#demo");
  assert.equal(landingHash("#ask-dave"), "#ask-dave");
});

test("demo hashes route to the five chapters; bare #demo opens the morning post", () => {
  assert.deepEqual(
    CHAPTERS.map((c) => c.id),
    ["bank", "rules", "post", "pay", "end"],
  );
  for (const id of ["bank", "rules", "post", "pay", "end"])
    assert.deepEqual(demoRoute("#demo/" + id), { chapter: id, hash: "#demo/" + id });
  for (const hash of ["#demo", "#demo/", "#demo/unknown"])
    assert.deepEqual(demoRoute(hash), { chapter: "post", hash: "#demo/post" });
  for (const hash of ["#agent-payments", "#ask-dave", "#payments", "", "#demolition"])
    assert.equal(demoRoute(hash), null);
});

test("the demo world hides the product sidebar and header, and restores them outside", () => {
  const node = (dataset: Record<string, string> = {}) => ({
    hidden: false,
    dataset,
    attrs: {} as Record<string, string>,
    setAttribute(name: string, value: string) { this.attrs[name] = value; },
    removeAttribute(name: string) { delete this.attrs[name]; },
  });
  const classes = new Set<string>();
  const sidebar = node(), topbar = node();
  const chapters = CHAPTERS.map((c) => node({ chapter: c.id }));
  const tabs = CHAPTERS.map((c) => node({ chapter: c.id }));
  const doc = {
    body: { classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) } },
    querySelector: (s: string) => (s === ".sidebar" ? sidebar : s === ".topbar" ? topbar : null),
    querySelectorAll: (s: string) => (s === ".dw-chapter" ? chapters : s === ".dw-tab" ? tabs : []),
  };
  applyDemoWorld(doc, "pay");
  assert.ok(classes.has("demo-world"));
  assert.equal(sidebar.hidden, true);
  assert.equal(topbar.hidden, true);
  assert.deepEqual(chapters.map((c) => c.hidden), [true, true, true, false, true]);
  assert.deepEqual(tabs.map((t) => t.attrs["aria-current"] ?? null), [null, null, null, "page", null]);
  applyDemoWorld(doc, null);
  assert.ok(!classes.has("demo-world"));
  assert.equal(sidebar.hidden, false);
  assert.equal(topbar.hidden, false);
  assert.ok(chapters.every((c) => c.hidden));
  assert.ok(tabs.every((t) => !("aria-current" in t.attrs)));
});

test("the demo shell links each chapter tab and exits to the product app", () => {
  const html = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
  assert.match(html, /<a id="demo-exit" class="dw-exit" href="#agent-payments" aria-label="Back to Countersign workspace">← Workspace<\/a>/);
  assert.match(html, /<span class="dw-mode">Local test funds<\/span>/);
  for (const c of CHAPTERS)
    assert.match(html, new RegExp(`href="#demo/${c.id}" data-chapter="${c.id}"><span class="dw-num">${c.number}</span>${c.label}</a>`));
  for (const id of ["demo-cafe", "cafe-feedback", "cafe-actions", "cafe-summary", "cafe-ledger", "cafe-bills", "cafe-progress", "cafe-read-at", "cafe-ask"])
    assert.match(html, new RegExp(`id="${id}"`), id);
  assert.doesNotMatch(html, /<script>|style="/);
});
