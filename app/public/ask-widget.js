// Floating "Ask Dave" widget: a round button on every view except #ask-dave
// that opens a compact read-only question panel. Reuses the shared Ask
// Dave request/answer logic, so it answers exactly what the main view does.
import { el } from "./components.js";
import { askSourceLabels } from "./ask-source.js";
import { runAsk, trimCards } from "./ask-shared.js";
import { questionForBill } from "./ask-suggest.js";

const HISTORY = 3,
  NOTE = "Dave answers about this vault's payments, blocks, rules and account checks. Not dates or anything outside the vault.";

export function createAskWidget({ onNavigate } = {}) {
  let button, panel, form, input, submitBtn;
  let submitting = false;

  button = el("button", "Ask Dave", "ask-fab");
  button.type = "button";
  button.title = "Ask Dave";
  button.addEventListener("click", open);

  const title = el("h2", "Ask Dave", "ask-widget-title"),
    closeBtn = el("button", "Close", "ask-widget-close"),
    header = el("div", "", "ask-widget-header"),
    hint = el("p", NOTE, "ask-widget-hint"),
    sourceNote = el("p", "", "ask-widget-source"),
    listTitle = el("h3", "Recent answers", "ask-widget-answers-title"),
    list = el("div", "", "ask-widget-answers ask-answer-list"),
    openLink = el("a", "Open full Ask Dave", "ask-widget-open"),
    panelFoot = el("footer", "", "ask-widget-footer");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close Ask Dave");
  title.id = "ask-widget-title";
  sourceNote.hidden = true;
  list.setAttribute("aria-label", "Recent Ask Dave answers");
  list.setAttribute("aria-live", "polite");
  openLink.href = "#ask-dave";
  // Navigate exactly like the page's nav links (no scroll jump); close
  // first so focus returns to the button when the panel hides.
  openLink.addEventListener("click", (event) => {
    event.preventDefault();
    close(false);
    if (onNavigate) onNavigate();
  });
  panelFoot.append(openLink);
  header.append(title, closeBtn);
  panel = el("div", "", "ask-widget-panel");
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "ask-widget-title");
  panel.hidden = true;
  panel.append(header, hint, sourceNote, listTitle, list, panelFoot);

  form = el("form", "", "ask-widget-form");
  input = el("input", "", "ask-widget-input");
  input.type = "text";
  input.name = "text";
  input.required = true;
  input.maxLength = 500;
  input.placeholder = "Ask about a bill, a block, the rules…";
  input.setAttribute("aria-label", "Ask Dave a question");
  input.autocomplete = "off";
  submitBtn = el("button", "Ask", "ask-widget-ask");
  submitBtn.type = "submit";
  form.append(input, submitBtn);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question || submitting) return;
    ask(question);
  });
  panel.insertBefore(form, listTitle);
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) close();
  });

  document.body.append(button, panel);

  async function ask(question) {
    if (submitting) return;
    submitting = true;
    submitBtn.disabled = true;
    try {
      const ok = await runAsk(list, question, {
        onSource: (source) => {
          sourceNote.textContent =
            "Source: " + askSourceLabels(source).question;
          sourceNote.hidden = false;
        },
        onFollowUp: (suggestion) => {
          if (!submitting) ask(suggestion);
        },
      });
      if (ok) input.value = "";
    } finally {
      submitting = false;
      submitBtn.disabled = false;
      trimCards(list, HISTORY);
    }
  }

  async function open(prefilled) {
    if (!panel.hidden) return;
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    if (prefilled) input.value = prefilled;
    input.focus();
    if (prefilled) ask(prefilled);
  }

  function close(refocus = true) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (refocus) button.focus();
  }

  return {
    button,
    panel,
    open,
    close,
    // Called by navigate() so the button stays off the Ask Dave view itself.
    setOnAskDaveView(on) {
      button.hidden = on;
      if (on) close();
    },
    askForBill(bill) {
      open(questionForBill(bill));
    },
  };
}
