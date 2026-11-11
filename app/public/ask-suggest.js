// Pure Ask Dave helpers. No DOM and no AI: follow-up chips and bill
// pre-fill questions are derived from the answer text and bill state only,
// so they stay unit-testable (see ask-suggest.test.ts).
const BLOCKED_LINE = /^\[([^\]\n]+)\][^\n:]*: (?:Blocked|Failed)\./;

export function suggestFollowUps(question, answerText) {
  const asked = String(question ?? "").trim().toLowerCase();
  const suggestions = [];
  for (const line of String(answerText ?? "").split("\n")) {
    const match = line.trim().match(BLOCKED_LINE);
    if (!match) continue;
    const id = match[1].trim();
    if (!id) continue;
    const text = "Why was " + id + " blocked?";
    // Skip the exact question that was just asked, and duplicates.
    if (text.toLowerCase() === asked) continue;
    if (suggestions.includes(text)) continue;
    suggestions.push(text);
    if (suggestions.length >= 3) break;
  }
  return suggestions;
}

export function questionForBill(bill) {
  const id = (bill && bill.id) || "";
  if (bill && (bill.outcome === "blocked" || bill.outcome === "failed"))
    return "Why was " + id + " blocked?";
  if (bill && bill.outcome === "paid") return "Was " + id + " paid?";
  return "What is the status of " + id + "?";
}
