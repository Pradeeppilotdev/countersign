// Shared, text-safe UI primitives. No invoice or provider text is interpreted as HTML.
export const $ = (selector) => document.querySelector(selector);
export function el(tag, value = "", className = "") {
  const node = document.createElement(tag);
  if (value !== null) node.textContent = String(value);
  if (className) node.className = className;
  return node;
}
const paths = {
  wallet: [
    "M4 5h14a2 2 0 0 1 2 2v12H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h13",
    "M20 10h-6v5h6",
    "M16 12.5h.01",
  ],
  route: [
    "M5 5a2 2 0 1 0 0 .01",
    "M19 19a2 2 0 1 0 0 .01",
    "M7 5h8a4 4 0 0 1 0 8H9a4 4 0 0 0 0 8h8",
  ],
  shield: ["M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z", "m8 12 3 3 5-6"],
  "arrow-up-right": ["M6 18 18 6", "M6 6h12v12"],
  "arrow-right": ["M4 12h16", "m14 6 6 6-6 6"],
  plus: ["M12 5v14", "M5 12h14"],
  check: ["m5 12 4 4L19 6"],
  "check-circle": ["M22 11v1a10 10 0 1 1-6-9", "m9 11 3 3L22 4"],
  refresh: [
    "M20 7v5h-5",
    "M4 17v-5h5",
    "M6 7a7 7 0 0 1 12-1l2 3",
    "M18 17a7 7 0 0 1-12 1l-2-3",
  ],
  receipt: ["M6 3h12v18l-3-2-3 2-3-2-3 2V3Z", "M9 7h6", "M9 11h6", "M9 15h3"],
  search: ["M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14", "m15 15 6 6"],
  lock: ["M6 10h12v11H6Z", "M8 10V7a4 4 0 0 1 8 0v3", "M12 14v3"],
  signature: [
    "M3 17c4-9 8-16 9-12 1 3-8 13-8 9 1-3 5-2 7 1s3-4 5-4 0 5 5 1",
    "M3 21h18",
  ],
  store: [
    "M3 9 5 3h14l2 6",
    "M3 9v3a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0V9Z",
    "M5 15v6h14v-6",
    "M10 21v-5h4v5",
  ],
  info: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20", "M12 11v6", "M12 7h.01"],
  alert: ["m12 3 10 18H2L12 3Z", "M12 9v5", "M12 18h.01"],
  clock: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20", "M12 6v6l4 2"],
  play: ["m8 4 12 8-12 8V4Z"],
  flask: [
    "M9 3h6",
    "M10 3v6L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3",
    "M7 15h10",
  ],
};
export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.7",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    class: "icon",
  }))
    svg.setAttribute(key, value);
  for (const d of paths[name] ?? paths.info) {
    const path = document.createElementNS(svg.namespaceURI, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
export function mountIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((node) => {
    node.replaceChildren(icon(node.dataset.icon));
  });
}
export function badge(value, tone = "neutral") {
  return el("span", value, "badge " + tone);
}
export function button(
  label,
  action,
  { tone = "secondary", small = true, iconName } = {},
) {
  const node = el("button", "", "button " + tone + (small ? " small" : ""));
  node.type = "button";
  if (iconName) node.append(icon(iconName));
  node.append(el("span", label));
  node.addEventListener("click", action);
  return node;
}
export function notice(target, title, tone = "info", detail = "") {
  target.replaceChildren();
  if (!title) return;
  const box = el("div", "", "notice " + tone);
  box.append(
    icon(
      tone === "danger" || tone === "warning"
        ? "alert"
        : tone === "success"
          ? "check-circle"
          : tone === "busy"
            ? "refresh"
            : "info",
    ),
  );
  const content = el("div", "");
  content.append(el("span", title, "notice-title"));
  if (detail) content.append(el("p", detail));
  box.append(content);
  target.append(box);
}
export function emptyState(title, description, action) {
  const box = el("div", "", "empty-state"),
    picture = el("div", "", "empty-illustration");
  picture.setAttribute("aria-hidden", "true");
  picture.append(icon("receipt"));
  const seal = el("span", "", "seal");
  seal.append(icon("check"));
  picture.append(seal);
  box.append(picture, el("h3", title), el("p", description));
  if (action) box.append(action);
  return box;
}
export function lockControls(root, busy) {
  root.setAttribute("aria-busy", String(busy));
  root.querySelectorAll("button,input,select").forEach((node) => {
    node.disabled = busy || node.dataset.allowed === "false";
  });
}
export async function api(path, body) {
  let response, data;
  try {
    response = await fetch(
      path,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    data = await response.json();
  } catch {
    throw Error(
      "Could not reach the local app. Reconnect, then refresh the saved state before retrying.",
    );
  }
  if (!response.ok)
    throw Error(
      data.error ??
        "The request could not be confirmed. Refresh before retrying.",
    );
  return data;
}
export function localTime(value) {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
