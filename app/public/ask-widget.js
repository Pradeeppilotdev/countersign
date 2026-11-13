// Ask Dave panel: a corner launcher and contextual bill actions.
// Opens a compact read-only question panel. Reuses the shared Ask
// Dave request/answer logic, so it answers exactly what the main view does.
import { el, icon } from "./components.js";
import { askSourceLabels } from "./ask-source.js";
import { runAsk, runAccountCheck, questionBox } from "./ask-shared.js";
import { questionForBill } from "./ask-suggest.js";

const HISTORY = 3,
  NOTE = "Answers from your agent vault. Dave can explain payments and rules, but can't change them.";

export function createAskWidget({ onNavigate } = {}) {
  let button, panel, form, input, submitBtn;
  let submitting = false, opener = null;

  button = el("button", "", "ask-fab");
  button.append(icon("dave"), el("span", "Ask Dave", "sr-only"));
  button.type = "button";
  button.title = "Ask Dave";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", "ask-widget-panel");
  button.setAttribute("aria-haspopup", "dialog");
  button.addEventListener("click", () => open(undefined, button));

  const title = el("h2", "", "ask-widget-title"),
    closeBtn = el("button", "Close", "button secondary small ask-widget-close"),
    header = el("div", "", "ask-widget-header"),
    hint = el("p", NOTE, "ask-widget-hint"),
    sourceNote = el("p", "", "ask-widget-source"),
    listTitle = el("h3", "Recent answers", "ask-widget-answers-title"),
    list = el("div", "", "ask-widget-answers ask-answer-list"),
    openLink = el("a", "Open full Ask Dave", "ask-widget-open"),
    disclaimer = el("p", "Dave is AI and can make mistakes. Payments are always decided by the vault.", "ask-widget-disclaimer"),
    panelFoot = el("footer", "", "ask-widget-footer");
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close Ask Dave");
  title.id = "ask-widget-title";
  title.append(icon("dave"), el("span", "Ask Dave"));
  sourceNote.hidden = true;
  list.setAttribute("aria-label", "Recent Ask Dave answers");
  list.setAttribute("aria-live", "polite");
  openLink.href = "#ask-dave";
  // The full view takes focus after navigation; do not focus the hidden opener.
  openLink.addEventListener("click", (event) => {
    event.preventDefault();
    close(false);
    if (onNavigate) onNavigate();
  });
  panelFoot.append(openLink);
  header.append(title, closeBtn);
  panel = el("div", "", "ask-widget-panel");
  panel.id = "ask-widget-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-labelledby", "ask-widget-title");
  panel.hidden = true;
  panel.append(header, hint, sourceNote, listTitle, list, disclaimer, panelFoot);

  form = el("form", "", "ask-widget-form");
  input = el("textarea", "", "ask-widget-input");
  input.rows = 1;
  input.name = "text";
  input.required = true;
  input.maxLength = 500;
  input.placeholder = "Ask about a bill, a block, the rules…";
  input.setAttribute("aria-label", "Ask Dave a question");
  input.autocomplete = "off";
  submitBtn = el("button", "Ask", "button primary ask-widget-ask");
  submitBtn.type = "submit";
  form.append(input, submitBtn);
  const questionBoxControl = questionBox(input, form);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || submitting) return;
    return ask(text);
  });
  panel.insertBefore(form, listTitle);
  closeBtn.addEventListener("click", () => close());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      // Non-modal: owners can tab back to the desk without losing focus on Esc.
      const inside = panel.contains(document.activeElement);
      close(inside);
      if (inside) event.preventDefault();
    }
  });

  const dock = el("div", "", "ask-widget-dock");
  dock.append(button);
  document.body.append(dock, panel);
  document.body.classList.add("has-dave-launcher");

  async function ask(question) {
    if (submitting) return;
    submitting = true;
    // The submitted question should not remain in the typing box while Dave replies.
    // Restore it only if the request fails and no replacement draft was typed.
    const submittedDraft = input.value;
    if (input.value.trim() === question) questionBoxControl.clear();
    input.focus();
    submitBtn.disabled = true;
    try {
      const ok = await runAsk(list, question, {
        maxCards: HISTORY,
        onSource: (source) => {
          sourceNote.textContent =
            "Source: " + askSourceLabels(source).question;
          sourceNote.hidden = false;
        },
        onFollowUp: (suggestion) => {
          if (submitting) return;
          input.value = suggestion;
          questionBoxControl.grow();
          input.focus();
          ask(suggestion);
        },
      });
      if (!ok && !input.value.trim()) {
        input.value = submittedDraft || question;
        questionBoxControl.grow();
      }
    } finally {
      submitting = false;
      submitBtn.disabled = false;
    }
  }

  function open(prefilled, trigger = document.activeElement) {
    opener = trigger;
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    if (typeof prefilled === "string") { input.value = prefilled; questionBoxControl.grow(); }
    input.focus();
  }

  function close(refocus = true) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (refocus) {
      const target = opener?.isConnected && opener.getClientRects().length ? opener
        : button.getClientRects().length ? button : document.querySelector('[data-view="ask-dave"]');
      if (target && !target.hidden) target.focus();
    }
  }

  return {
    button,
    panel,
    open,
    close,
    // Called by navigate() so the button stays off the Ask Dave view itself.
    setOnAskDaveView(on) {
      const moveFocus = on && (panel.contains(document.activeElement) || document.activeElement === button);
      button.hidden = on;
      dock.hidden = on;
      document.body.classList[on ? "remove" : "add"]("has-dave-launcher");
      if (on) close(false);
      return moveFocus;
    },
    askForBill(bill, trigger) {
      open(questionForBill(bill), trigger);
    },
    // Same read-only check as the Ask Dave view's "Would you pay this account?".
    async checkAccount(account, trigger) {
      open(undefined, trigger);
      return runAccountCheck(list, account, { maxCards: HISTORY });
    },
  };
}
