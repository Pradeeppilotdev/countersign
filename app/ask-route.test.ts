import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handleAsk } from "./ask-route.ts";
import { AskError } from "../agent/ask/views.ts";

const NO_VAULT = "No agent vault yet. Run npm run agent:desk -- init first.";
const BUSY = "Ask Dave is busy, try again in a moment.";
const GENERIC = "Ask Dave couldn't answer that.";

// The route keeps one shared in-flight counter and last-question timestamp
// for the whole server, so each test gets a clock offset far outside the
// 5000 ms window of every previous test.
let clockBase = 0;
function deps(overrides: Record<string, unknown> = {}) {
  clockBase += 60_000;
  let t = clockBase;
  const calls: { args: string[]; dir: string }[] = [];
  return {
    calls,
    ask: async (args: string[], dir: string) => {
      calls.push({ args, dir });
      return "ANSWER";
    },
    agentDir: "/agent-vault",
    vaultExists: () => true,
    now: () => t,
    advance: (ms: number) => (t += ms),
    ...overrides,
  };
}

test("non-object or unknown kind is rejected with 400", async () => {
  const d = deps();
  for (const input of [null, 42, "hello", [], {}, { kind: "other" }, { kind: "question" }]) {
    const r = await handleAsk(input, d);
    assert.equal(r.status, 400, JSON.stringify(input));
    assert.equal(r.body.ok, false);
  }
  assert.equal(d.calls.length, 0);
});

test("a 501-character question or one starting with - is rejected with 400", async () => {
  const d = deps();
  const r1 = await handleAsk({ kind: "question", text: "x".repeat(501) }, d);
  assert.deepEqual(r1, { status: 400, body: { ok: false, error: "Invalid question." } });
  const r2 = await handleAsk({ kind: "question", text: "-facts" }, d);
  assert.equal(r2.status, 400);
  const r3 = await handleAsk({ kind: "question", text: "   " }, d);
  assert.equal(r3.status, 400);
  const r4 = await handleAsk({ kind: "question", text: 42 }, d);
  assert.equal(r4.status, 400);
  assert.equal(d.calls.length, 0);
  // The boundary: 500 chars is allowed.
  const ok = await handleAsk({ kind: "question", text: "x".repeat(500) }, d);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.text, "ANSWER");
  assert.equal(d.calls.length, 1);
});

test("an invalid account is rejected with 400", async () => {
  const d = deps();
  for (const account of [null, 1, "UPPER", "a", "bad..name", "x".repeat(65), "has space"]) {
    const r = await handleAsk({ kind: "account", account }, d);
    assert.equal(r.status, 400, String(account));
    assert.equal(r.body.ok, false);
  }
  assert.equal(d.calls.length, 0);
});

test("no agent vault means a safe 200 with the init hint", async () => {
  const d = deps({ vaultExists: () => false });
  const r = await handleAsk({ kind: "question", text: "How is my agent doing?" }, d);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: false, error: NO_VAULT });
  assert.equal(d.calls.length, 0);
});

test("a second question within 5000 ms is 429, but an account check is not rate-limited", async () => {
  const d = deps();
  const first = await handleAsk({ kind: "question", text: "How is my agent doing?" }, d);
  assert.equal(first.status, 200);
  // Same moment, second question.
  const second = await handleAsk({ kind: "question", text: "Why was INV-BEANS-003 blocked?" }, d);
  assert.equal(second.status, 429);
  assert.deepEqual(second.body, { ok: false, error: BUSY });
  // Account checks at the same moment are never rate-limited.
  const check = await handleAsk({ kind: "account", account: "beans.near" }, d);
  assert.equal(check.status, 200);
  assert.equal(check.body.text, "ANSWER");
  // The same question is allowed again after the 5000 ms window.
  d.advance(5000);
  const later = await handleAsk({ kind: "question", text: "How is my agent doing?" }, d);
  assert.equal(later.status, 200);
  assert.deepEqual(d.calls.map((c) => c.args), [
    ["How is my agent doing?"],
    ["--account", "beans.near"],
    ["How is my agent doing?"],
  ]);
});

test("one question in flight blocks a second question", async () => {
  let release: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const d = deps({
    ask: async () => {
      await gate;
      return "ANSWER";
    },
  });
  const first = handleAsk({ kind: "question", text: "How is my agent doing?" }, d);
  await Promise.resolve();
  const second = await handleAsk({ kind: "question", text: "What are my current rules?" }, d);
  assert.equal(second.status, 429);
  assert.deepEqual(second.body, { ok: false, error: BUSY });
  release!();
  assert.equal((await first).status, 200);
});

test("AskError becomes a 200 with its message; other errors become a generic 500", async (t) => {
  const d1 = deps({
    ask: async () => {
      throw new AskError("Ask Dave: the local chain is not answering.");
    },
  });
  const r1 = await handleAsk({ kind: "question", text: "Why was INV-BEANS-003 blocked?" }, d1);
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.body, { ok: false, error: "Ask Dave: the local chain is not answering." });

  const log = [];
  const d2 = deps({
    ask: async () => {
      throw new Error("secret detail: api key leaked");
    },
  });
  t.mock.method(console, "error", (...args: unknown[]) => log.push(args));
  const r2 = await handleAsk({ kind: "question", text: "How is my agent doing?" }, d2);
  assert.equal(r2.status, 500);
  assert.deepEqual(r2.body, { ok: false, error: GENERIC });
  assert.equal(log.length, 1);
  assert.ok(!JSON.stringify(r2).includes("secret detail"));
});

test("the route handler source imports only views and node built-ins", () => {
  const source = readFileSync(fileURLToPath(import.meta.url.replace("ask-route.test.ts", "ask-route.ts")), "utf8");
  for (const forbidden of ["executor", "near-api", "transaction", "sign"])
    assert.ok(!source.includes(forbidden), `source must not contain "${forbidden}"`);
  assert.match(source, /from '\.\.\/agent\/ask\/views\.ts'/);
});
