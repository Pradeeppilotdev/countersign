// Demo world routing. Pure helpers plus one DOM toggle that only uses
// attributes and classList, so it stays unit-testable (see ui.test.ts).
export const CHAPTERS = [
  { id: "bank", number: "01", label: "The bank" },
  { id: "rules", number: "02", label: "Your rules" },
  { id: "post", number: "03", label: "Morning post" },
  { id: "pay", number: "04", label: "Agent pays" },
  { id: "end", number: "05", label: "End of day" },
];
export const DEFAULT_CHAPTER = "post";
export const landingHash = (hash) => hash || "#agent-payments";

// null: not a demo hash. Otherwise the chapter to show and its canonical hash.
export function demoRoute(hash) {
  const value = String(hash ?? "");
  if (value !== "#demo" && !value.startsWith("#demo/")) return null;
  const wanted = value.slice("#demo/".length);
  const chapter = CHAPTERS.some((c) => c.id === wanted) ? wanted : DEFAULT_CHAPTER;
  return { chapter, hash: "#demo/" + chapter };
}

// chapter null leaves the demo world and restores the product chrome.
export function applyDemoWorld(doc, chapter) {
  const on = Boolean(chapter);
  doc.body.classList.toggle("demo-world", on);
  for (const selector of [".sidebar", ".topbar"]) {
    const node = doc.querySelector(selector);
    if (node) node.hidden = on;
  }
  doc.querySelectorAll(".dw-chapter").forEach((node) => {
    node.hidden = node.dataset.chapter !== chapter;
  });
  doc.querySelectorAll(".dw-tab").forEach((node) => {
    if (node.dataset.chapter === chapter) {
      node.setAttribute("aria-current", "page");
      // Narrow screens scroll the tab strip; keep the current chapter visible.
      node.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    } else node.removeAttribute("aria-current");
  });
}
