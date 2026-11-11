import {
  $,
  el,
  icon,
  badge,
  button,
  notice,
  emptyState,
  lockControls,
  api,
  localTime,
} from "./components.js";
import {
  formatUnits,
  parseUnits,
  invoiceState,
  paymentActions,
  draftStatus,
  nextInvoiceId,
  filterInvoices,
} from "./state.js";
const root = $("#payments"),
  form = $("#sandbox-invoice");
let state = null,
  busy = false,
  reading = false,
  readRevision = 0,
  lastInvoiceRender = null,
  lastDraftRender = null;
function syncDraft() {
  if (!state) return;
  const result = draftStatus(
    form.elements.id.value,
    form.elements.amount.value,
    state.invoices,
  );
  $("#authorize").dataset.allowed = String(!result.disabled);
  $("#authorize").disabled = busy || result.disabled;
  $("#authorize-label").textContent = result.label ?? "Authorize invoice";
  const signature = JSON.stringify([
    form.elements.id.value,
    form.elements.amount.value,
    result,
  ]);
  if (signature === lastDraftRender) return;
  lastDraftRender = signature;
  if (result.disabled)
    notice(
      $("#authorization-feedback"),
      result.title,
      result.tone,
      result.detail,
    );
  else if (!busy) notice($("#authorization-feedback"), "");
}
function newInvoice() {
  if (busy || !state) return;
  form.elements.id.value = nextInvoiceId(state.invoices);
  form.elements.amount.value = "0.1";
  $("#invoice-search").value = "";
  $("#invoice-filter").value = "all";
  renderInvoices();
  syncDraft();
  form.elements.id.focus();
}
function renderInvoices() {
  const target = $("#sandbox-invoices");
  if (!state) return;
  const signature = JSON.stringify([
    state.invoices,
    $("#invoice-search").value,
    $("#invoice-filter").value,
    busy,
  ]);
  if (signature === lastInvoiceRender) return;
  lastInvoiceRender = signature;
  target.replaceChildren();
  const all = state.invoices,
    list = filterInvoices(
      all,
      $("#invoice-search").value,
      $("#invoice-filter").value,
    );
  $("#invoice-count").textContent = all.length;
  if (!list.length) {
    target.append(
      emptyState(
        all.length ? "No matching invoices" : "Your first invoice starts here",
        all.length
          ? "Try another reference or show all invoices."
          : "Authorize a bill to see its approval, reservation and payment here.",
        all.length
          ? button(
              "Clear filters",
              () => {
                $("#invoice-search").value = "";
                $("#invoice-filter").value = "all";
                renderInvoices();
              },
              { tone: "secondary" },
            )
          : button("Create an invoice", newInvoice, {
              tone: "secondary",
              iconName: "plus",
            }),
      ),
    );
    return;
  }
  for (const p of list) {
    const status = invoiceState(p),
      card = el("article", "", "invoice-card");
    card.setAttribute("aria-label", "Invoice " + p.id);
    const top = el("div", "", "invoice-top"),
      symbol = el("span", "", "invoice-symbol");
    symbol.append(icon(p.state === "Settled" ? "check-circle" : "receipt"));
    const identity = el("div", "", "invoice-identity");
    identity.append(
      el("h3", p.id),
      el("small", p.invoice?.payee ?? state.merchant),
    );
    const value = el("div", "", "invoice-value"),
      amount = el("strong", p.invoice ? formatUnits(p.invoice.amount) : "—");
    amount.append(el("span", " NEAR"));
    value.append(amount, badge(status.label, status.tone));
    top.append(symbol, identity, value);
    card.append(top);
    const progress = el("p", "", "invoice-status");
    progress.append(
      icon(p.state === "Settled" ? "check-circle" : "clock"),
      el("span", status.detail),
    );
    card.append(progress);
    const actions = el("div", "", "invoice-actions");
    for (const item of paymentActions(p)) {
      const b = button(item.label, () => run(item.action, { id: p.id }), {
        tone: item.tone,
        iconName: item.action === "execute" ? "arrow-right" : undefined,
      });
      b.disabled = busy;
      actions.append(b);
    }
    if (actions.children.length) card.append(actions);
    const meta = el("details", "", "invoice-meta");
    meta.append(
      el("summary", "Payment details"),
      el("code", "Attempt: " + p.attempt),
    );
    if (p.expiresAt)
      meta.append(
        el(
          "p",
          "Approval expires " + new Date(Number(p.expiresAt)).toLocaleString(),
        ),
      );
    card.append(meta);
    target.append(card);
  }
}
function render(s) {
  state = s;
  const ready = s.phase === "READY";
  $("#sandbox-body").hidden = !ready;
  $("#sandbox-start").hidden = ready;
  $("#new-invoice").disabled = !ready || busy;
  $("#connection").textContent = ready ? "Vault connected" : "Vault offline";
  if (!ready) return;
  const balances = $("#sandbox-balances");
  balances.replaceChildren();
  for (const [title, value, unit, note, cls] of [
    [
      "Available in vault",
      formatUnits(s.available),
      "NEAR",
      "Ready for approved payments",
      "balance-primary",
    ],
    [
      "Paid to merchant",
      formatUnits(s.merchantReceived),
      "NEAR",
      "Confirmed transfers only",
      "",
    ],
    [
      "Invoices",
      String(s.invoices.length),
      "",
      s.invoices.filter((p) => p.state === "Settled").length +
        " paid · " +
        s.invoices.filter((p) => !["Settled", "Cancelled"].includes(p.state))
          .length +
        " open",
      "",
    ],
  ]) {
    const item = el("div", "", cls),
      amount = el("strong", value);
    if (unit) amount.append(el("span", unit));
    item.append(el("span", title, "metric-label"), amount, el("small", note));
    balances.append(item);
  }
  $("#sandbox-payee").textContent = s.merchant;
  $("#sandbox-vault").textContent = "Vault: " + s.vault;
  renderInvoices();
  syncDraft();
  const events = $("#sandbox-events");
  events.replaceChildren();
  $("#activity-count").textContent =
    s.events.length > 8
      ? "Latest 8 of " + s.events.length
      : s.events.length + " events";
  for (const e of s.events.slice(-8).reverse()) {
    const item = el("li", "", "activity-item"),
      mark = el("span", "", "activity-marker"),
      time = el("time", localTime(e.at));
    time.dateTime = e.at;
    time.title = new Date(e.at).toLocaleString();
    mark.append(icon("check"));
    item.append(mark, el("p", e.message), time);
    events.append(item);
  }
}
// Ignore a late read once an action starts; a background refresh must not eat a click
// or replace the action's newer chain state. Unchanged rows also retain keyboard focus.
async function read({ silent = false } = {}) {
  if (reading || busy) return;
  reading = true;
  const revision = readRevision;
  try {
    const snapshot = await api("/api/sandbox");
    if (revision !== readRevision) return;
    render(snapshot);
    if (!silent)
      notice($("#sandbox-message"), "Vault state refreshed", "success");
  } catch (error) {
    if (revision === readRevision) {
      $("#connection").textContent = "Connection lost";
      $("#sandbox-start").hidden = false;
      notice(
        $("#sandbox-message"),
        "Could not refresh the vault",
        "danger",
        error.message,
      );
    }
  } finally {
    reading = false;
  }
}
async function run(action, input = {}) {
  if (busy) return;
  readRevision++;
  busy = true;
  lockControls(root, true);
  const output =
    action === "authorize"
      ? $("#authorization-feedback")
      : $("#sandbox-message");
  notice(
    output,
    action === "authorize"
      ? "Recording owner approval…"
      : action === "execute"
        ? "Waiting for payment confirmation…"
        : "Waiting for the local chain…",
    "busy",
  );
  let failed = false;
  try {
    const result = await api("/api/sandbox/" + action, input);
    render(result);
    const p = result.invoices.find((p) => p.id === input.id);
    const detail = result.events.at(-1)?.message ?? "Local vault ready.";
    notice(
      output,
      action === "authorize"
        ? "Invoice authorized"
        : action === "duplicate"
          ? "Duplicate blocked. No extra payment."
          : action === "execute"
            ? p?.state === "Settled"
              ? "Payment settled"
              : p?.state === "Failed"
                ? "Transfer failed"
                : "Payment confirmation pending"
            : action === "reserve"
              ? "Funds reserved"
              : action === "cancel"
                ? "Invoice cancelled"
                : action === "release_failed"
                  ? "Failed-transfer allowance released"
                  : "Vault connected",
      action === "execute" && p?.state !== "Settled" ? "warning" : "success",
      detail,
    );
  } catch (error) {
    failed = true;
    notice(output, "Action was not confirmed", "danger", error.message);
    try {
      render(await api("/api/sandbox"));
    } catch {}
    notice(output, "Action was not confirmed", "danger", error.message);
  } finally {
    busy = false;
    lockControls(root, false);
    if (state) {
      const result = draftStatus(
        form.elements.id.value,
        form.elements.amount.value,
        state.invoices,
      );
      $("#authorize").dataset.allowed = String(!result.disabled);
      $("#authorize").disabled = result.disabled;
      $("#authorize-label").textContent = result.label ?? "Authorize invoice";
    }
    if (!failed && action === "authorize") {
      $("#invoice-filter").value = "all";
      $("#invoice-search").value = "";
    }
    renderInvoices();
  }
}
form.addEventListener("input", syncDraft);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy || $("#authorize").disabled) return;
  try {
    parseUnits(form.elements.amount.value);
    run("authorize", {
      id: form.elements.id.value,
      amount: form.elements.amount.value,
    });
  } catch (error) {
    notice(
      $("#authorization-feedback"),
      "Check the amount",
      "danger",
      error.message,
    );
  }
});
$("#new-invoice").addEventListener("click", newInvoice);
$("#sandbox-start").addEventListener("click", () => run("start"));
$("#sandbox-refresh").addEventListener("click", () => read());
$("#invoice-search").addEventListener("input", renderInvoices);
$("#invoice-filter").addEventListener("change", renderInvoices);
read({ silent: true });
// Read pending settlements automatically. Never submit another transfer from a timer.
setInterval(() => {
  if (
    !document.hidden &&
    state?.invoices.some(
      (p) =>
        p.state === "Executing" ||
        (!root.hidden && ["Authorized", "Reserved"].includes(p.state)),
    )
  )
    read({ silent: true });
}, 15000);
