// Demo invoice documents. Every invoice, genuine or tampered, is drawn by the
// same code with the same classes: nothing here knows which ones are bad.
import { el } from "./components.js";
import { formatUnits } from "./state.js";

const SUPPLIERS = {
  "Bean-Co": { description: "Coffee roasters", lines: [["House roast beans, 20 kg", 9n], ["Delivery", 1n]] },
  "Milk-Co": { description: "Dairy", lines: [["Whole milk, 40 L", 1n]] },
  "Pastry-Co": { description: "Bakery", lines: [["Croissants & pastries", 17n], ["Delivery", 3n]] },
};
const FALLBACK = { description: "Supplier", lines: [["Goods and services", 1n]] };
export const supplierInfo = (merchant) => SUPPLIERS[merchant] ?? FALLBACK;

// Exact split in yoctoNEAR: weighted shares, the first line takes the remainder,
// so the lines always add up to the invoice amount.
export function lineItems(merchant, amount) {
  const total = BigInt(amount),
    lines = supplierInfo(merchant).lines,
    weight = lines.reduce((sum, [, w]) => sum + w, 0n);
  const amounts = lines.map(([, w]) => (total * w) / weight);
  amounts[0] += total - amounts.reduce((sum, a) => sum + a, 0n);
  return lines.map(([label], i) => ({ label, amount: amounts[i].toString() }));
}

// INV-BEANS-01-3f9cbc12 → BEANS-01
export function shortBill(id) {
  const match = String(id ?? "").match(/^INV-([A-Z]+-\d+)-/);
  return match ? match[1] : String(id ?? "");
}

export const SIGNATURE_SENTENCE = (supplier) =>
  `The signature doesn't match. Something on this invoice was changed after ${supplier} signed it.`;

const near = (yocto) => formatUnits(yocto) + " NEAR";
export function dueLine(invoice) {
  if (invoice.week) return "Week " + invoice.week;
  if (invoice.expires_at == null) return "—";
  const at = new Date(Number(invoice.expires_at));
  return Number.isNaN(at.getTime()) ? "—" : at.toLocaleDateString() + " " + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function meta(label, value) {
  const cell = el("div", "", "inv-meta-cell");
  cell.append(el("span", label, "inv-label"), el("strong", value));
  return cell;
}

// invoice: {id, merchant, supplier, payee, amount (yocto), expires_at, week}
export function invoiceDocument(invoice, issuedAt) {
  const info = supplierInfo(invoice.merchant),
    doc = el("article", "", "inv-doc"),
    head = el("header", "", "inv-head"),
    who = el("div", "", "inv-who"),
    title = el("div", "", "inv-title");
  who.append(el("h3", invoice.supplier, "inv-supplier"), el("p", info.description, "inv-desc"));
  title.append(el("span", "INVOICE", "inv-label"), el("strong", shortBill(invoice.id), "inv-no"));
  head.append(who, title);
  const metaRow = el("div", "", "inv-meta"),
    issued = new Date(issuedAt ?? Date.now());
  metaRow.append(meta("Billed to", "Dave's Café"), meta("Issued", issued.toLocaleDateString()), meta("Due", dueLine(invoice)));
  const lines = el("div", "", "inv-lines");
  for (const line of lineItems(invoice.merchant, invoice.amount)) {
    const row = el("div", "", "inv-line");
    row.append(el("span", line.label), el("span", near(line.amount), "inv-amount"));
    lines.append(row);
  }
  const total = el("div", "", "inv-line inv-total");
  total.append(el("span", "Total due"), el("span", near(invoice.amount), "inv-amount"));
  const pay = el("div", "", "inv-pay");
  pay.append(el("span", "Pay to", "inv-label"), el("strong", invoice.payee, "inv-payee"));
  doc.append(head, metaRow, lines, total, pay, el("footer", `Digitally signed by ${invoice.supplier} · Ed25519`, "inv-foot"));
  doc.setAttribute("aria-label", `Invoice ${shortBill(invoice.id)} from ${invoice.supplier}`);
  return doc;
}
