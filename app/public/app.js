import {
  $,
  el,
  icon,
  badge,
  button,
  notice,
  lockControls,
  api,
  localTime,
  mountIcons,
} from "./components.js";
import {
  formatUnits,
  parseUnits,
  simulationState,
  createQuoteSelection,
} from "./state.js";
import { refreshAgentPayments, askFromBill } from "./agent-payments.js";
import { askSourceLabels } from "./ask-source.js";
import { askCard, setBusy, setAnswer, setCardError, askDave, checkAccount, appendFollowUps } from "./ask-shared.js";
import { createAskWidget } from "./ask-widget.js";
mountIcons();
let askWidgetView = null;
function navigate() {
  const view =
    location.hash === "#payments"
      ? "payments"
      : location.hash === "#quote-lab"
      ? "quote-lab"
      : location.hash === "#ask-dave"
        ? "ask-dave"
        : "agent-payments";
  $("#nav-tools").open = view === "payments" || view === "quote-lab";
  document
    .querySelectorAll(".workspace-view")
    .forEach((node) => (node.hidden = node.id !== view));
  document.querySelectorAll("[data-view]").forEach((node) => {
    if (node.dataset.view === view) node.setAttribute("aria-current", "page");
    else node.removeAttribute("aria-current");
  });
  $("#page-label").textContent =
    view === "agent-payments"
      ? "Agent payments"
      : view === "payments"
      ? "Manual payment desk"
      : view === "ask-dave"
        ? "Ask Dave"
        : "1Click lab";
  document.title = "Countersign · " + $("#page-label").textContent;
  if (view === "ask-dave") refreshAskSource();
  if (view === "agent-payments") refreshAgentPayments();
  if (askWidgetView) askWidgetView(view);
}
window.addEventListener("hashchange", navigate);
navigate();
document
  .querySelectorAll(
    'a[href="#payments"],a[href="#quote-lab"],a[href="#ask-dave"],a[href="#agent-payments"]',
  )
  .forEach((link) =>
    link.addEventListener("click", (event) => {
      event.preventDefault();
      history.pushState(null, "", link.href);
      navigate();
      window.scrollTo({ top: 0, behavior: "instant" });
    }),
  );
window.addEventListener("popstate", navigate);
const root = $("#quote-lab"),
  selection = createQuoteSelection();
let records = [],
  busy = false,
  quoteCleared = false;
const amount = (value) => formatUnits(value, 6);
function renderHistory() {
  const target = $("#history");
  target.replaceChildren();
  $("#count").textContent = records.length;
  $("#held").textContent = records.filter(
    (r) => r.simulation.state === "NEEDS_REVIEW",
  ).length;
  if (!records.length) {
    target.append(
      el(
        "p",
        "No reviews yet. Load the signed demo or verify your first quote.",
        "history-empty",
      ),
    );
    return;
  }
  for (const r of records) {
    const [label, tone] = simulationState(r.simulation.state),
      row = button(
        "",
        () => {
          selection.select(r.id);
          render(r);
          renderHistory();
          notice(
            $("#message"),
            "Viewing a saved review",
            "info",
            "This review belongs to " +
              r.id +
              ". Editing the request clears this selection.",
          );
        },
        { tone: "ghost" },
      );
    row.className = "history-row";
    row.setAttribute("aria-pressed", String(selection.current() === r.id));
    row.disabled = busy;
    const name = el("div", r.id);
    name.append(
      el(
        "small",
        amount(r.validation.amountOut) +
          " USDC · " +
          (r.mode === "ARCHIVED_REPLAY"
            ? "Archived signed demo"
            : "Live dry-run quote"),
      ),
    );
    row.replaceChildren(name, badge(label, tone));
    target.append(row);
  }
}
async function refresh() {
  records = await api("/api/workflows");
  renderHistory();
}
function resetReview() {
  quoteCleared = quoteCleared || selection.current() !== null;
  selection.edit();
  $("#detail").hidden = true;
  $("#detail").replaceChildren();
  $("#empty").hidden = false;
  renderHistory();
}
function render(r) {
  $("#empty").hidden = true;
  const detail = $("#detail");
  detail.hidden = false;
  detail.replaceChildren();
  const archived = r.mode === "ARCHIVED_REPLAY";
  detail.append(
    badge(
      archived ? "Signed demo · archived" : "Signature and limits checked",
      "success",
    ),
  );
  const quoted = el("div", amount(r.validation.amountOut), "quote-amount");
  quoted.append(el("span", " USDC"));
  detail.append(
    quoted,
    el("p", "Exact output to the recipient on Base", "quote-caption"),
  );
  for (const [key, value, id] of [
    ["Invoice", r.id],
    ["Quoted input", amount(r.validation.amountIn) + " USDC on NEAR"],
    [
      "Freshness",
      Date.now() >= r.validation.expiresAt
        ? "Expired · preview only"
        : "Fresh · preview only",
      "quote-freshness",
    ],
    ["Swap execution", "Unavailable in this lab"],
  ]) {
    const row = el("div", "", "kv"),
      v = el("strong", value);
    if (id) v.id = id;
    row.append(el("span", key), v);
    detail.append(row);
  }
  if (archived) {
    const note = el("div");
    notice(
      note,
      "An authentic quote captured earlier",
      "info",
      "Use this saved example to explore settlement. It is not a live offer for your current request.",
    );
    detail.append(note);
  }
  const sim = el("section", "", "simulation"),
    [label, tone] = simulationState(r.simulation.state);
  sim.append(
    el("h3", "Settlement simulator"),
    el(
      "p",
      "Choose a provider event to see how the payment would be tracked. No swap is sent.",
    ),
    badge(label, tone),
  );
  if (r.simulation.state === "NEEDS_REVIEW") {
    const warning = el("div");
    notice(
      warning,
      "Held for review",
      "warning",
      "Conflicting or failed events keep this payment on hold. A later success cannot clear it automatically.",
    );
    sim.append(warning);
  }
  const actions = el("div", "", "actions");
  for (const [status, title] of [
    ["PROCESSING", "Processing"],
    ["SUCCESS", "Success"],
    ["FAILED", "Failure"],
    ["REFUNDED", "Refund"],
  ]) {
    const b = button(
      title,
      () =>
        run(async () => {
          const version = selection.version();
          await api("/api/simulate", { id: r.id, status });
          await refresh();
          if (selection.accept(r.id, version))
            render(records.find((row) => row.id === r.id));
          notice(
            $("#message"),
            title + " event recorded",
            "success",
            "Simulation only. Funds moved: 0 USDC.",
          );
        }),
      { tone: "secondary" },
    );
    b.disabled = busy;
    actions.append(b);
  }
  sim.append(actions);
  for (const event of r.events.slice().reverse()) {
    const row = el("div", "", "event");
    row.append(
      el("span", event.status + " · simulated"),
      el("small", localTime(event.updatedAt)),
    );
    sim.append(row);
  }
  detail.append(sim);
  const fingerprint = el("details", "", "quote-fingerprint");
  fingerprint.append(
    el("summary", "Quote fingerprint"),
    el("code", r.validation.quoteHash),
  );
  detail.append(fingerprint);
}
async function run(task) {
  if (busy) return;
  busy = true;
  lockControls(root, true);
  notice($("#message"), "Checking the request…", "busy");
  try {
    await task();
  } catch (error) {
    notice(
      $("#message"),
      "Request could not be verified",
      "danger",
      error.message,
    );
  } finally {
    busy = false;
    lockControls(root, false);
  }
}
$("#demo").addEventListener("click", () =>
  run(async () => {
    resetReview();
    const version = selection.version(),
      r = await api("/api/replay", {});
    await refresh();
    if (selection.accept(r.id, version)) {
      render(r);
      renderHistory();
      notice(
        $("#message"),
        "Signed demo loaded",
        "success",
        "This archived quote is ready for a local settlement simulation.",
      );
    }
  }),
);
$("#invoice").addEventListener("input", () => {
  resetReview();
  if (quoteCleared)
    notice(
      $("#message"),
      "Request changed",
      "warning",
      "The previous quote has been cleared. Verify these details again.",
    );
  else notice($("#message"), "");
});
$("#invoice").addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  resetReview();
  const version = selection.version(),
    fields = new FormData(event.target);
  run(async () => {
    const policy = {
      originAsset:
        "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      destinationAsset:
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      recipient: fields.get("recipient"),
      refundTo: fields.get("refundTo"),
      amountOut: parseUnits(fields.get("amount"), 6),
      maxAmountIn: parseUnits(fields.get("cap"), 6),
      deadline: new Date(Date.now() + 600000).toISOString(),
    };
    const r = await api("/api/preview", { id: fields.get("id"), policy });
    await refresh();
    if (selection.accept(r.id, version)) {
      render(r);
      renderHistory();
      notice(
        $("#message"),
        "Quote verified",
        "success",
        "The signature and spending limit checks passed. Swap execution remains disabled.",
      );
    }
  });
});
refresh().catch((error) =>
  notice(
    $("#message"),
    "Could not load saved reviews",
    "danger",
    error.message,
  ),
);
setInterval(() => {
  const r = records.find((row) => row.id === selection.current()),
    label = $("#quote-freshness");
  if (r && label)
    label.textContent =
      Date.now() >= r.validation.expiresAt
        ? "Expired · preview only"
        : "Fresh · preview only";
}, 15000);

// --- Ask Dave -------------------------------------------------------------
const askList = $("#ask-answers");
function showAskSource(source) {
  const labels = askSourceLabels(source);
  notice($("#ask-source"), labels.question, source.agentVault ? "info" : "warning", labels.detail);
  $("#ask-account-network").textContent = "Account checks: " + labels.account;
  $("#ask-account").placeholder = source.accountNetwork === "local"
    ? "merchant.test.near"
    : source.accountNetwork === "testnet" ? "supplier.testnet" : "supplier.near";
  return labels;
}
async function refreshAskSource() {
  try { showAskSource(await api("/api/ask/source")); }
  catch {
    notice($("#ask-source"), "Agent vault source unavailable", "warning", "Reconnect to the local app to identify the vault before asking.");
    $("#ask-account-network").textContent = "Account lookup network unavailable";
  }
}
let askEmpty = el("p", "Ask a question or check an account to see an answer here.", "ask-empty");
askList.append(askEmpty);
const askForm = $("#ask-question-form"),
  askTextInput = $("#ask-text"),
  askBtn = $("#ask-submit"),
  askBtnLabel = $("#ask-label"),
  accountForm = $("#ask-account-form"),
  accountInput = $("#ask-account"),
  checkBtn = $("#ask-check-button"),
  checkBtnLabel = $("#ask-check-label");

function prependAskCard(card) {
  if (askEmpty) {
    askEmpty.remove();
    askEmpty = null;
  }
  askList.prepend(card);
}
async function runAskCard(kind, label, payload, button, labelNode, busyText) {
  const isAccount = kind === "account",
    { card, head, body } = askCard(label);
  prependAskCard(card);
  setBusy(body, isAccount ? "Checking the account…" : "Asking Dave…");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const original = labelNode.textContent;
  labelNode.textContent = busyText;
  try {
    const data = isAccount ? await checkAccount(payload.account) : await askDave(payload.text);
    if (data.source) {
      const labels = showAskSource(data.source);
      card.insertBefore(el("p", "Source: " + (isAccount ? labels.account : labels.question), "ask-sources"), body);
    }
    if (data.ok && data.text != null) {
      setAnswer(head, body, data.text, isAccount);
      if (!isAccount) appendFollowUps(card, label, data, (suggestion) => {
        if (askBtn.disabled) return;
        askTextInput.value = suggestion;
        askTextInput.focus();
        askForm.requestSubmit();
      });
    }
    else setCardError(body, data.error ?? "No answer.");
  } catch (error) {
    setCardError(body, error.message);
  } finally {
    button.disabled = false;
    button.setAttribute("aria-busy", "false");
    labelNode.textContent = original;
  }
}
askForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (askBtn.disabled) return;
  const text = askTextInput.value.trim();
  if (!text) return;
  runAskCard("question", text, { text }, askBtn, askBtnLabel, "Asking…");
});
accountForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (checkBtn.disabled) return;
  const account = accountInput.value.trim();
  if (!account) return;
  runAskCard("account", "Account: " + account, { account }, checkBtn, checkBtnLabel, "Checking…");
});
document
  .querySelectorAll("#ask-dave .chip")
  .forEach((chip) =>
    chip.addEventListener("click", () => {
      // A question is already running: leave what the owner typed alone.
      if (askBtn.disabled) return;
      askTextInput.value = chip.dataset.example;
      askForm.requestSubmit();
    }),
  );

// --- Ask Dave everywhere (floating button + panel) -------------------------
const askWidget = createAskWidget({
  onNavigate: () => {
    history.pushState(null, "", "#ask-dave");
    navigate();
    askTextInput.focus();
    window.scrollTo({ top: 0, behavior: "instant" });
  },
});
askFromBill((bill, trigger) => askWidget.askForBill(bill, trigger));
askWidgetView = (view) => {
  if (askWidget.setOnAskDaveView(view === "ask-dave")) askTextInput.focus();
};
askWidgetView(location.hash === "#ask-dave" ? "ask-dave" : null);
