import { buildClickDispatcher } from "../src/browser/actions/domEvents.js";

export const browserProofScript = String.raw`async ({ chipSelectors, level, token }) => {
  ${buildClickDispatcher()}
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalize = (value) => (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  const isVisible = (node) => {
    if (!(node instanceof HTMLElement)) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  const cloneStyled = (node) => {
    if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || "");
    if (!(node instanceof Element)) return document.createElement("span");
    const clone = node.cloneNode(false);
    const computed = getComputedStyle(node);
    clone.setAttribute("style", Array.from(computed).map((name) => name + ":" + computed.getPropertyValue(name) + ";").join(""));
    node.childNodes.forEach((child) => clone.appendChild(cloneStyled(child)));
    return clone;
  };
  const findMenu = () =>
    Array.from(document.querySelectorAll('[role="menu"], [data-radix-collection-root], [role="group"]'))
      .filter(isVisible)
      .find((candidate) => {
        const text = normalize(candidate.textContent);
        return text.includes("thinking effort") || text.includes("thinking time") || (text.includes("thinking") && text.includes("standard") && text.includes("extended")) || (text.includes("light") && text.includes("standard") && text.includes("extended"));
      }) || null;
  window.scrollTo(0, document.body.scrollHeight);
  await sleep(600);
  const candidates = [];
  for (const selector of chipSelectors) {
    for (const button of document.querySelectorAll(selector)) {
      if (!(button instanceof HTMLElement) || !isVisible(button)) continue;
      const meta = normalize([button.getAttribute("aria-label"), button.textContent, button.className].filter(Boolean).join(" "));
      let score = 0;
      if (meta.includes("thinking")) score += 200;
      if (meta === "pro" || meta.includes(" pro ")) score += 140;
      if (meta.includes("composer-pill")) score += 80;
      if (button.closest?.('[data-testid="composer-footer-actions"]')) score += 60;
      if (button.closest?.('[class*="composer"]')) score += 40;
      if (score > 0) candidates.push({ button, score });
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  const chip = candidates[0]?.button ?? null;
  if (!chip) throw new Error("Unable to find the Pro/Thinking chip");
  chip.scrollIntoView({ block: "center", inline: "center" });
  await sleep(300);
  let menu = findMenu();
  for (let attempt = 0; !menu && attempt < 3; attempt += 1) {
    dispatchClickSequence(chip);
    await sleep(350);
    menu = findMenu();
  }
  const items = menu ? Array.from(menu.querySelectorAll('button, [role="menuitem"], [role="menuitemradio"], [data-testid*="model-switcher-"]')).map((item) => ({ text: (item.textContent || "").trim(), ariaChecked: item.getAttribute("aria-checked"), dataState: item.getAttribute("data-state"), role: item.getAttribute("role") })) : [];
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "background:" + (getComputedStyle(document.body).backgroundColor || "#ffffff") + ";padding:24px;display:inline-flex;flex-direction:column;gap:16px;";
  wrapper.appendChild(cloneStyled(chip));
  if (menu) wrapper.appendChild(cloneStyled(menu));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="420"><foreignObject width="100%" height="100%">' + new XMLSerializer().serializeToString(wrapper) + "</foreignObject></svg>";
  const image = new Image();
  image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  await new Promise((resolve, reject) => { image.onload = () => resolve(null); image.onerror = reject; });
  const canvas = document.createElement("canvas");
  canvas.width = 420;
  canvas.height = 420;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D context unavailable");
  context.fillStyle = getComputedStyle(document.body).backgroundColor || "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0);
  return { href: location.href, title: document.title, proofPresent: document.body.innerText.includes(token), chipText: (chip.textContent || "").trim(), menuFound: Boolean(menu), items, pngDataUrl: canvas.toDataURL("image/png"), thinkingTime: level };
}`;
