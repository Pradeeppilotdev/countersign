// Ask Dave shared request and answer-rendering logic, used by the main
// #ask-dave view, the floating Ask Dave panel, and the bill cards.
// All server text is rendered with textContent only. A 429 "busy" reply
// arrives as an api() error and is shown as a card error.
import { el, badge, api } from "./components.js";
import { askSourceLabels } from "./ask-source.js";
import { suggestFollowUps } from "./ask-suggest.js";

export function askCard(label) {
  const card = el("article", "", "ask-card"),
    head = el("header", "", "ask-card-head"),
    body = el("div", "", "ask-card-body");
  head.append(el("h3", label, "ask-card-title"));
  card.append(head, body);
  return { card, head, body };
}

export function setBusy(body, text = "Asking Dave…") {
  body.replaceChildren(el("p", text, "ask-loading"));
}

// Verified replies use "reply\n\nrecords\nSources: ...". Split at the last
// blank line because the reply may itself contain a line break.
export function splitAnswer(text) {
  const value = String(text ?? ""), at = value.lastIndexOf("\n\n");
  if (at <= 0) return null;
  const reply = value.slice(0, at).trim(), records = value.slice(at + 2);
  if (!reply || !records.trim() || !/^Sources: .+$/m.test(records.split("\n").at(-1))) return null;
  return { reply, records };
}
function recordLines(target, text) {
  for (const line of String(text).split("\n"))
    target.append(el("div", line, line.startsWith("Sources:") ? "ask-sources" : "ask-line"));
}
let recordsId = 0;
function foldedAnswer(body, { reply, records }) {
  for (const line of reply.split("\n")) body.append(el("div", line, "ask-line ask-reply"));
  const toggle = el("button", "Show the vault records", "ask-records-toggle"),
    details = el("div", "", "ask-records");
  toggle.type = "button";
  details.id = "ask-records-" + ++recordsId;
  details.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", details.id);
  recordLines(details, records);
  toggle.addEventListener("click", () => {
    details.hidden = !details.hidden;
    toggle.setAttribute("aria-expanded", String(!details.hidden));
    toggle.textContent = details.hidden ? "Show the vault records" : "Hide the vault records";
  });
  body.append(toggle, details);
}

export function setAnswer(head, body, text, isAccount = false) {
  body.replaceChildren();
  body.classList.remove("has-error");
  if (isAccount) {
    const result = String(text).match(/^(PAY|WARN|STOP):[ \t]*([^\n]*)/);
    if (result) {
      const verdict = result[1], reason = result[2].trim();
      const statement = verdict === "PAY"
        ? "Yes — this is a recognised supplier payment account. Your vault has paid it before."
        : verdict === "STOP"
          ? "No — do not pay this account."
          : "Not yet — verify this account before paying.";
      body.append(el("p", statement, "ask-account-decision"));
      if (verdict !== "PAY" && reason) body.append(el("p", reason, "ask-account-reason"));
      body.append(el("p", "This is an account check, not approval of the invoice. The bill must still pass its signature, payee, amount and spending-rule checks.", "ask-account-note"));
      const detail = el("details", "", "ask-account-checks");
      const report = el("div", "", "ask-records");
      recordLines(report, String(text).split("\n").slice(1).join("\n"));
      detail.append(el("summary", "Show account checks"), report);
      body.append(detail);
      if (head) head.append(badge(verdict === "PAY" ? "YES" : verdict === "STOP" ? "NO" : "CHECK", verdict === "PAY" ? "success" : verdict === "STOP" ? "danger" : "warning"));
      return;
    }
  }
  const split = isAccount ? null : splitAnswer(text);
  if (split) foldedAnswer(body, split);
  else recordLines(body, text);
}

export function setCardError(body, message) {
  setAnswer(null, body, message);
  body.classList.add("has-error");
}

export function renderAnswer(container, label, text) {
  const { card, body } = askCard(label);
  setAnswer(null, body, text);
  container.prepend(card);
  return card;
}

export function askDave(question) {
  return api("/api/ask", { kind: "question", text: question });
}

export function checkAccount(id) {
  return api("/api/ask", { kind: "account", account: id });
}

export function sourceLine(source, isAccount = false) {
  const labels = askSourceLabels(source);
  return el("p", "Source: " + (isAccount ? labels.account : labels.question), "ask-sources");
}

function followUpChip(question, onAsk) {
  const chip = el("button", question, "chip ask-chip");
  chip.type = "button";
  chip.addEventListener("click", () => onAsk(question));
  return chip;
}

// Appends up to three clickable chips, built by code from the answer text
// (no AI), when the reply is a successful question answer.
export function appendFollowUps(card, question, data, onAsk) {
  if (!data.ok || data.text == null || !onAsk) return null;
  const row = el("div", "", "ask-followups");
  for (const suggestion of suggestFollowUps(question, data.text))
    row.append(followUpChip(suggestion, onAsk));
  if (row.childElementCount) card.append(row);
  return row;
}

// Shows the source line (when present) and the answer, or the card error.
// Returns true when the answer is ok.
export function applyAsk(card, head, body, data, isAccount = false) {
  if (data.source) card.insertBefore(sourceLine(data.source, isAccount), body);
  if (data.ok && data.text != null) {
    setAnswer(head, body, data.text, isAccount);
    return true;
  }
  setCardError(body, data.error ?? "No answer.");
  return false;
}

// Asks one question and renders the answer (or the busy/error reply) as a
// card prepended to container. When the reply carries a source it is shown
// under the question and reported via onSource. Returns true when the
// answer is ok.
export async function runAsk(container, question, { onSource, onFollowUp, maxCards = Infinity } = {}) {
  const { card, head, body } = askCard(question);
  container.prepend(card);
  trimCards(container, maxCards);
  setBusy(body);
  try {
    const data = await askDave(question);
    if (data.source && onSource) onSource(data.source);
    const ok = applyAsk(card, head, body, data);
    if (ok) appendFollowUps(card, question, data, onFollowUp);
    return ok;
  } catch (error) {
    setCardError(body, error.message);
    return false;
  }
}

// Runs the read-only account check (no model) and renders it as a card.
export async function runAccountCheck(container, account, { maxCards = Infinity } = {}) {
  const { card, head, body } = askCard(account);
  container.prepend(card);
  trimCards(container, maxCards);
  setBusy(body, "Checking…");
  try {
    return applyAsk(card, head, body, await checkAccount(account), true);
  } catch (error) {
    setCardError(body, error.message);
    return false;
  }
}

// Keeps at most max cards in container, dropping the oldest first.
export function trimCards(container, max) {
  while (container.children.length > max) container.lastElementChild.remove();
}

// Shared by the full page and the floating panel. CSS caps the height at six lines.
export function questionBox(textarea, form) {
  const grow = () => {
    textarea.style.height = "auto";
    textarea.style.height = textarea.scrollHeight + 2 + "px";
  };
  textarea.addEventListener("input", grow);
  textarea.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit();
  });
  return { grow, clear() { textarea.value = ""; grow(); } };
}

// --- One answer history, shared by the full page and the floating panel ----
// Kept per browser tab in sessionStorage. Every read and write is guarded: when
// storage is missing or throws, the history still works in memory for this page.
export const HISTORY_KEY = "countersign.ask-history.v1", HISTORY_MAX = 30;
const KINDS = new Set(["question", "account"]);
const str = (value) => typeof value === "string" ? value : undefined;
function cleanData(data) {
  const out = { ok: data?.ok === true };
  for (const key of ["text", "error"]) if (str(data?.[key]) !== undefined) out[key] = data[key];
  const source = data?.source;
  if (source && typeof source === "object" && !Array.isArray(source)) {
    const kept = {};
    for (const key of ["agentVault", "paymentVault", "accountNetwork"]) if (str(source[key]) !== undefined) kept[key] = source[key];
    if (typeof source.separate === "boolean") kept.separate = source.separate;
    out.source = kept;
  }
  return out;
}
const defaultStorage = () => { try { return globalThis.sessionStorage ?? null; } catch { return null; } };

export function createAskHistory({ storage = defaultStorage } = {}) {
  const store = () => { try { return typeof storage === "function" ? storage() : storage; } catch { return null; } };
  let nextId = 0, entries = [];
  const listeners = new Set();
  try {
    const parsed = JSON.parse(store()?.getItem(HISTORY_KEY) ?? "[]");
    if (Array.isArray(parsed))
      entries = parsed.filter((e) => e && KINDS.has(e.kind) && typeof e.label === "string" && e.data && typeof e.data === "object")
        .slice(0, HISTORY_MAX).map((e) => ({ id: ++nextId, kind: e.kind, label: e.label, data: cleanData(e.data) }));
  } catch { entries = []; }
  // In-flight answers are shown but never saved: a reload must not leave a card waiting forever.
  const save = () => {
    try { store()?.setItem(HISTORY_KEY, JSON.stringify(entries.filter((e) => e.data).map(({ kind, label, data }) => ({ kind, label, data })))); }
    catch { /* memory only */ }
  };
  const notify = () => { for (const fn of [...listeners]) fn(entries); };
  return {
    entries: () => entries,
    begin(kind, label) {
      const entry = { id: ++nextId, kind, label, data: null };
      entries = [entry, ...entries].slice(0, HISTORY_MAX);
      notify();
      return entry.id;
    },
    finish(id, data) {
      const at = entries.findIndex((e) => e.id === id);
      if (at < 0) return; // cleared while it was waiting
      entries = entries.map((e, i) => i === at ? { ...e, data: cleanData(data) } : e);
      save(); notify();
    },
    clear() {
      entries = [];
      try { store()?.removeItem(HISTORY_KEY); } catch { /* memory only */ }
      notify();
    },
    subscribe(fn) { listeners.add(fn); fn(entries); return () => listeners.delete(fn); },
  };
}
export const askHistory = createAskHistory();

// Asks (or checks an account) and records the answer, the busy reply or the error in history.
export async function askIntoHistory(history, kind, value, { onSource } = {}) {
  const isAccount = kind === "account",
    id = history.begin(kind, isAccount ? "Account: " + value : value);
  let data;
  try { data = await (isAccount ? checkAccount(value) : askDave(value)); }
  catch (error) { data = { ok: false, error: error.message }; }
  if (data?.source && onSource) onSource(data.source);
  history.finish(id, data);
  return !!(data?.ok && data.text != null);
}

// Renders history into container with the same cards everywhere. A finished card is
// built once per container and then reused, so an opened records fold stays open.
export function showHistory(history, container, { max = HISTORY_MAX, onFollowUp, empty } = {}) {
  const built = new Map();
  return history.subscribe((entries) => {
    const shown = entries.slice(0, max), cards = [];
    for (const entry of shown) {
      let item = built.get(entry.id);
      if (!item || item.done !== !!entry.data) {
        const isAccount = entry.kind === "account", { card, head, body } = askCard(entry.label);
        if (!entry.data) setBusy(body, isAccount ? "Checking the account…" : "Asking Dave…");
        else if (applyAsk(card, head, body, entry.data, isAccount) && !isAccount)
          appendFollowUps(card, entry.label, entry.data, onFollowUp);
        item = { card, done: !!entry.data };
        built.set(entry.id, item);
      }
      cards.push(item.card);
    }
    for (const id of [...built.keys()]) if (!shown.some((e) => e.id === id)) built.delete(id);
    if (!cards.length && empty) cards.push(empty);
    container.replaceChildren(...cards);
  });
}
