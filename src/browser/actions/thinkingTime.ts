import type { ChromeClient, BrowserLogger } from "../types.js";
import type { ThinkingTimeLevel } from "../../oracle/types.js";
import { MENU_CONTAINER_SELECTOR, MENU_ITEM_SELECTOR } from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";

type ThinkingTimeOutcome =
  | { status: "already-selected"; label?: string | null }
  | { status: "switched"; label?: string | null }
  | { status: "chip-not-found" }
  | { status: "menu-not-found" }
  | { status: "option-not-found" };

async function evaluateWithTimeout(
  Runtime: ChromeClient["Runtime"],
  params: Parameters<ChromeClient["Runtime"]["evaluate"]>[0],
  timeoutMs: number,
  message: string,
) {
  return await Promise.race([
    Runtime.evaluate(params),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs)),
  ]);
}

/**
 * Selects a specific thinking time level in ChatGPT's composer pill menu.
 * @param level - The thinking time intensity: 'light', 'standard', 'extended', or 'heavy'
 */
export async function ensureThinkingTime(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
) {
  const result = await evaluateThinkingTimeSelection(Runtime, level);
  const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);

  switch (result?.status) {
    case "already-selected":
      logger(`Thinking time: ${result.label ?? capitalizedLevel} (already selected)`);
      return;
    case "switched":
      logger(`Thinking time: ${result.label ?? capitalizedLevel}`);
      return;
    case "chip-not-found": {
      await logDomFailure(Runtime, logger, "thinking-chip");
      throw new Error("Unable to find the Thinking chip button in the composer area.");
    }
    case "menu-not-found": {
      await logDomFailure(Runtime, logger, "thinking-time-menu");
      throw new Error("Unable to find the Thinking time dropdown menu.");
    }
    case "option-not-found": {
      await logDomFailure(Runtime, logger, `${level}-option`);
      throw new Error(`Unable to find the ${capitalizedLevel} option in the Thinking time menu.`);
    }
    default: {
      await logDomFailure(Runtime, logger, "thinking-time-unknown");
      throw new Error(`Unknown error selecting ${capitalizedLevel} thinking time.`);
    }
  }
}

/**
 * Best-effort selection of a thinking time level in ChatGPT's composer pill menu.
 * Safe by default: if the pill/menu/option isn't present, we continue without throwing.
 * @param level - The thinking time intensity: 'light', 'standard', 'extended', or 'heavy'
 */
export async function ensureThinkingTimeIfAvailable(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
  logger: BrowserLogger,
): Promise<boolean> {
  try {
    const result = await evaluateThinkingTimeSelection(Runtime, level);
    const capitalizedLevel = level.charAt(0).toUpperCase() + level.slice(1);

    switch (result?.status) {
      case "already-selected":
        logger(`Thinking time: ${result.label ?? capitalizedLevel} (already selected)`);
        return true;
      case "switched":
        logger(`Thinking time: ${result.label ?? capitalizedLevel}`);
        return true;
      case "chip-not-found":
      case "menu-not-found":
      case "option-not-found":
        if (logger.verbose) {
          logger(`Thinking time: ${result.status.replaceAll("-", " ")}; continuing with default.`);
        }
        return false;
      default:
        if (logger.verbose) {
          logger("Thinking time: unknown outcome; continuing with default.");
        }
        return false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (logger.verbose) {
      logger(`Thinking time selection failed (${message}); continuing with default.`);
      await logDomFailure(Runtime, logger, "thinking-time");
    }
    return false;
  }
}

async function evaluateThinkingTimeSelection(
  Runtime: ChromeClient["Runtime"],
  level: ThinkingTimeLevel,
): Promise<ThinkingTimeOutcome | undefined> {
  const outcome = await evaluateWithTimeout(
    Runtime,
    {
      expression: buildThinkingTimeExpression(level),
      awaitPromise: true,
      returnByValue: true,
    },
    20_000,
    `Timed out while selecting the ${level} thinking-time option`,
  );

  return outcome.result?.value as ThinkingTimeOutcome | undefined;
}

function buildThinkingTimeExpression(level: ThinkingTimeLevel): string {
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  const targetLevelLiteral = JSON.stringify(level.toLowerCase());

  return `(async () => {
    ${buildClickDispatcher()}

    const MENU_CONTAINER_SELECTOR = ${menuContainerLiteral};
    const MENU_ITEM_SELECTOR = ${menuItemLiteral};
    const TARGET_LEVEL = ${targetLevelLiteral};
    const CHIP_SELECTORS = [
      '[data-testid="composer-footer-actions"] button[aria-haspopup="menu"]',
      'button.__composer-pill[aria-haspopup="menu"]',
      '.__composer-pill-composite button[aria-haspopup="menu"]',
    ];
    const LEVEL_KEYWORDS = ['light', 'standard', 'extended', 'heavy'];

    const INITIAL_WAIT_MS = 150;
    const MAX_WAIT_MS = 10000;
    const MENU_OPEN_TIMEOUT_MS = 1500;

    const normalize = (value) => (value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\\s+/g, ' ')
      .trim();
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const dispatchEscape = () => {
      try {
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            keyCode: 27,
            which: 27,
            bubbles: true,
          }),
        );
      } catch {}
    };

    const findThinkingMenu = () => {
      const menus = document.querySelectorAll(MENU_CONTAINER_SELECTOR + ', [role="group"]');
      for (const menu of menus) {
        const label = menu.querySelector?.('.__menu-label, [class*="menu-label"]');
        if (normalize(label?.textContent ?? '').includes('thinking time')) {
          return menu;
        }
        const text = normalize(menu.textContent ?? '');
        if (text.includes('standard') && text.includes('extended')) {
          return menu;
        }
      }
      return null;
    };

    const buttonMetadata = (btn) =>
      normalize(
        [
          btn.getAttribute?.('aria-label') ?? '',
          btn.getAttribute?.('title') ?? '',
          btn.getAttribute?.('data-testid') ?? '',
          btn.textContent ?? '',
        ].join(' '),
      );
    const looksLikeModelChip = (metadata) =>
      metadata.includes('model-switcher') ||
      metadata.includes('current model') ||
      metadata.includes('chatgpt') ||
      metadata.includes('gpt') ||
      metadata === 'pro' ||
      metadata === 'instant' ||
      /\\b5 [0-9]\\b/.test(metadata);
    const collectThinkingChipCandidates = () => {
      const seen = new Set();
      const candidates = [];
      for (const selector of CHIP_SELECTORS) {
        const buttons = document.querySelectorAll(selector);
        for (const btn of buttons) {
          if (!(btn instanceof HTMLElement)) continue;
          if (btn.getAttribute?.('aria-haspopup') !== 'menu') continue;
          const metadata = buttonMetadata(btn);
          if (!metadata) continue;
          let score = 0;
          if (metadata.includes('thinking time')) score += 200;
          if (LEVEL_KEYWORDS.some((keyword) => metadata.includes(keyword))) score += 120;
          if (metadata.includes('thinking')) score += 60;
          if (looksLikeModelChip(metadata) && !metadata.includes('thinking time')) {
            score -= 80;
          }
          if (score <= 0) continue;
          const rect = btn.getBoundingClientRect();
          const key = [
            btn.getAttribute?.('data-testid') ?? '',
            metadata,
            String(Math.round(rect.left)),
            String(Math.round(rect.top)),
          ].join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ node: btn, score, rect });
        }
      }
      return candidates
        .sort((left, right) => right.score - left.score || right.rect.left - left.rect.left)
        .map((candidate) => candidate.node);
    };
    const waitForThinkingMenu = async (timeoutMs = MENU_OPEN_TIMEOUT_MS) => {
      const start = performance.now();
      while (performance.now() - start <= timeoutMs) {
        const menu = findThinkingMenu();
        if (menu) {
          return menu;
        }
        await wait(100);
      }
      return null;
    };
    const ensureThinkingMenu = async () => {
      const existingMenu = findThinkingMenu();
      if (existingMenu) {
        return { status: 'ready', menu: existingMenu };
      }
      const candidates = collectThinkingChipCandidates();
      if (candidates.length === 0) {
        return { status: 'chip-not-found' };
      }
      for (const candidate of candidates) {
        dispatchClickSequence(candidate);
        await wait(INITIAL_WAIT_MS);
        const menu = await waitForThinkingMenu();
        if (menu) {
          return { status: 'ready', menu };
        }
        dispatchEscape();
        await wait(120);
      }
      return { status: 'menu-not-found' };
    };
    const findTargetOption = (menu) => {
      const items = menu.querySelectorAll(MENU_ITEM_SELECTOR);
      for (const item of items) {
        const text = normalize(item.textContent ?? '');
        if (text.includes(TARGET_LEVEL)) {
          return item;
        }
      }
      return null;
    };
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const ariaChecked = node.getAttribute('aria-checked');
      const dataState = (node.getAttribute('data-state') || '').toLowerCase();
      if (ariaChecked === 'true') return true;
      if (dataState === 'checked' || dataState === 'selected' || dataState === 'on') return true;
      return false;
    };

    const menuState = await ensureThinkingMenu();
    if (menuState.status !== 'ready') {
      return { status: menuState.status };
    }

    const start = performance.now();
    while (performance.now() - start <= MAX_WAIT_MS) {
      const menu = findThinkingMenu() ?? menuState.menu;
      const targetOption = menu ? findTargetOption(menu) : null;
      if (targetOption) {
        const alreadySelected =
          optionIsSelected(targetOption) ||
          optionIsSelected(targetOption.querySelector?.('[aria-checked="true"], [data-state="checked"], [data-state="selected"]'));
        const label = targetOption.textContent?.trim?.() || null;
        dispatchClickSequence(targetOption);
        return { status: alreadySelected ? 'already-selected' : 'switched', label };
      }
      if (!findThinkingMenu()) {
        dispatchEscape();
        return { status: 'menu-not-found' };
      }
      await wait(100);
    }
    return { status: 'option-not-found' };
  })()`;
}

export function buildThinkingTimeExpressionForTest(level: ThinkingTimeLevel = "extended"): string {
  return buildThinkingTimeExpression(level);
}
