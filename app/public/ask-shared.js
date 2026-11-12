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

export function setAnswer(head, body, text, isAccount = false) {
  body.replaceChildren();
  body.classList.remove("has-error");
  for (const line of String(text).split("\n"))
    body.append(el("div", line, line.startsWith("Sources:") ? "ask-sources" : "ask-line"));
  if (isAccount) {
    const t = String(text),
      verdict = t.startsWith("STOP")
        ? ["STOP", "danger"]
        : t.startsWith("WARN")
          ? ["WARN", "warning"]
          : t.startsWith("PAY")
            ? ["PAY", "success"]
            : null;
    if (verdict) head.append(badge(verdict[0], verdict[1]));
  }
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

// Keeps at most max cards in container, dropping the oldest first.
export function trimCards(container, max) {
  while (container.children.length > max) container.lastElementChild.remove();
}
