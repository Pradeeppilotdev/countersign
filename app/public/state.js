// Pure display rules shared by the desk and its regression tests. The vault is the authority.
export function formatUnits(value, decimals = 24) {
  const n = BigInt(value),
    scale = 10n ** BigInt(decimals),
    fraction = (n % scale)
      .toString()
      .padStart(decimals, "0")
      .replace(/0+$/, "");
  return String(n / scale) + (fraction ? "." + fraction : "");
}
export function parseUnits(value, decimals = 24) {
  if (
    typeof value !== "string" ||
    !new RegExp("^\\d{1,30}(\\.\\d{1," + decimals + "})?$").test(value)
  )
    throw Error(
      "Enter a positive amount with at most " + decimals + " decimal places.",
    );
  const [whole, fraction = ""] = value.split(".");
  const n =
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0"));
  if (n <= 0n) throw Error("Enter an amount greater than zero.");
  return n.toString();
}
export function invoiceState(payment) {
  const expired = payment.expired;
  if (payment.state === "Settled")
    return {
      label: "Paid",
      tone: "success",
      detail:
        "Settlement confirmed by the vault. This bill cannot be paid again.",
    };
  if (payment.state === "Cancelled")
    return {
      label: "Cancelled",
      tone: "neutral",
      detail: "This invoice is closed. Use a new reference for a new bill.",
    };
  if (payment.state === "Failed")
    return {
      label: "Transfer failed",
      tone: "danger",
      detail:
        "Release the confirmed failure allowance before using it for another bill.",
    };
  if (payment.state === "Executing")
    return {
      label: "Confirming",
      tone: "info",
      detail:
        "Waiting for settlement. Refresh to check; no new payment is submitted.",
    };
  if (expired)
    return {
      label: "Expired",
      tone: "warning",
      detail:
        payment.state === "Reserved"
          ? "The payment was never sent. Cancel to release this expired hold."
          : "This approval has expired. Cancel it and create a new invoice.",
    };
  if (payment.state === "Reserved")
    return {
      label: "Reserved",
      tone: "info",
      detail: "Funds are held for this invoice. It is ready for payment.",
    };
  if (payment.state === "Authorized")
    return {
      label: "Authorized",
      tone: "neutral",
      detail: "Approval recorded. Reserve the committed amount to continue.",
    };
  return {
    label: "Unconfirmed",
    tone: "warning",
    detail: "Authorization could not be confirmed. Refresh before retrying.",
  };
}
export function paymentActions(p) {
  if (p.state === "Settled")
    return [
      {
        action: "duplicate",
        label: "Test duplicate protection",
        tone: "ghost",
      },
    ];
  if (p.state === "Authorized")
    return [
      ...(!p.expired
        ? [{ action: "reserve", label: "Reserve funds", tone: "primary" }]
        : []),
      { action: "cancel", label: "Cancel invoice", tone: "ghost" },
    ];
  if (p.state === "Reserved")
    return p.expired
      ? [{ action: "cancel", label: "Release expired hold", tone: "secondary" }]
      : [{ action: "execute", label: "Pay test NEAR", tone: "primary" }];
  if (p.state === "Failed")
    return [
      {
        action: "release_failed",
        label: "Release failed-transfer budget",
        tone: "secondary",
      },
    ];
  return [];
}
export function draftStatus(id, amount, payments) {
  const previous = payments.find((p) => p.id === id);
  if (!previous?.state) return { disabled: false };
  let same = false;
  try {
    same = previous.invoice?.amount === parseUnits(amount);
  } catch {}
  return {
    disabled: true,
    label: same ? "Already recorded" : "Reference in use",
    tone: same ? "success" : "danger",
    title: same
      ? "Invoice already recorded"
      : "This reference has different terms",
    detail: same
      ? "Find " +
        id +
        " in the invoice list to continue. No new authorization is needed."
      : "Amounts cannot be changed after approval. Use a new reference for this bill.",
  };
}
export function nextInvoiceId(payments) {
  const ids = new Set(payments.map((p) => p.id));
  let n = 1;
  while (ids.has("SANDBOX-" + String(n).padStart(3, "0"))) n++;
  return "SANDBOX-" + String(n).padStart(3, "0");
}
export function filterInvoices(payments, query = "", filter = "all") {
  return payments
    .filter(
      (p) =>
        p.id.toLowerCase().includes(query.toLowerCase()) &&
        (filter === "all" ||
          (filter === "paid"
            ? p.state === "Settled"
            : !["Settled", "Cancelled"].includes(p.state))),
    )
    .slice()
    .reverse();
}
export function simulationState(state) {
  return (
    {
      SIMULATED_PENDING: ["Ready to simulate", "neutral"],
      SIMULATED_PROCESSING: ["Processing · simulated", "info"],
      SIMULATED_PROVIDER_SUCCESS: ["Success · simulated", "success"],
      SIMULATED_PROVIDER_REFUND: ["Refund · simulated", "neutral"],
      NEEDS_REVIEW: ["Needs review", "warning"],
    }[state] ?? ["Unknown state", "warning"]
  );
}
// A response may update history, but may never reattach an old quote to edited input.
export function createQuoteSelection() {
  let revision = 0,
    selected = null;
  return {
    edit() {
      revision++;
      selected = null;
      return revision;
    },
    version() {
      return revision;
    },
    select(id) {
      revision++;
      selected = id;
      return revision;
    },
    current() {
      return selected;
    },
    accept(id, version) {
      if (version !== revision) return false;
      selected = id;
      return true;
    },
  };
}
