import type { ChromeClient, BrowserLogger, BrowserModelStrategy } from "../types.js";
import {
  MENU_CONTAINER_SELECTOR,
  MENU_ITEM_SELECTOR,
  MODEL_BUTTON_SELECTOR,
} from "../constants.js";
import { logDomFailure } from "../domDebug.js";
import { buildClickDispatcher } from "./domEvents.js";

type ModelVersion = "5-4" | "5-2" | "5-1" | "5-0";

interface ModelTargetTraits {
  normalizedTarget: string;
  normalizedTokens: string[];
  targetWords: string[];
  desiredVersion: ModelVersion | null;
  wantsPro: boolean;
  wantsInstant: boolean;
  wantsThinking: boolean;
}

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

export async function ensureModelSelection(
  Runtime: ChromeClient["Runtime"],
  desiredModel: string,
  logger: BrowserLogger,
  strategy: BrowserModelStrategy = "select",
) {
  const outcome = await evaluateWithTimeout(
    Runtime,
    {
      expression: buildModelSelectionExpression(desiredModel, strategy),
      awaitPromise: true,
      returnByValue: true,
    },
    30_000,
    `Timed out while selecting the ChatGPT model (${desiredModel})`,
  );

  const result = outcome.result?.value as
    | { status: "already-selected"; label?: string | null }
    | { status: "switched"; label?: string | null }
    | {
        status: "option-not-found";
        hint?: { temporaryChat?: boolean; availableOptions?: string[] };
      }
    | { status: "button-missing" }
    | undefined;

  switch (result?.status) {
    case "already-selected":
    case "switched": {
      const label = result.label ?? desiredModel;
      logger(`Model picker: ${label}`);
      return;
    }
    case "option-not-found": {
      await logDomFailure(Runtime, logger, "model-switcher-option");
      const isTemporary = result.hint?.temporaryChat ?? false;
      const available = (result.hint?.availableOptions ?? []).filter(Boolean);
      const availableHint = available.length > 0 ? ` Available: ${available.join(", ")}.` : "";
      const tempHint =
        isTemporary && /\bpro\b/i.test(desiredModel)
          ? ' You are in Temporary Chat mode; Pro models are not available there. Remove "temporary-chat=true" from --chatgpt-url or use a non-Pro model (e.g. gpt-5.2).'
          : "";
      throw new Error(
        `Unable to find model option matching "${desiredModel}" in the model switcher.${availableHint}${tempHint}`,
      );
    }
    default: {
      await logDomFailure(Runtime, logger, "model-switcher-button");
      throw new Error("Unable to locate the ChatGPT model selector button.");
    }
  }
}

/**
 * Builds the DOM expression that runs inside the ChatGPT tab to select a model.
 * The string is evaluated inside Chrome, so keep it self-contained and well-commented.
 */
function buildModelSelectionExpression(
  targetModel: string,
  strategy: BrowserModelStrategy,
): string {
  const matchers = buildModelMatchersLiteral(targetModel);
  const traits = buildModelTargetTraits(targetModel, matchers.labelTokens);
  const labelLiteral = JSON.stringify(matchers.labelTokens);
  const idLiteral = JSON.stringify(matchers.testIdTokens);
  const primaryLabelLiteral = JSON.stringify(targetModel);
  const traitsLiteral = JSON.stringify(traits);
  const strategyLiteral = JSON.stringify(strategy);
  const menuContainerLiteral = JSON.stringify(MENU_CONTAINER_SELECTOR);
  const menuItemLiteral = JSON.stringify(MENU_ITEM_SELECTOR);
  return `(() => {
    ${buildClickDispatcher()}
    // Capture the selectors and matcher literals up front so the browser expression stays pure.
    const BUTTON_SELECTOR = '${MODEL_BUTTON_SELECTOR}';
    const LABEL_TOKENS = ${labelLiteral};
    const TEST_IDS = ${idLiteral};
    const PRIMARY_LABEL = ${primaryLabelLiteral};
    const TARGET_TRAITS = ${traitsLiteral};
    const MODEL_STRATEGY = ${strategyLiteral};
    const INITIAL_WAIT_MS = 150;
    const REOPEN_INTERVAL_MS = 400;
    const MAX_WAIT_MS = 20000;
    const normalizeText = (value) => {
      if (!value) {
        return '';
      }
      return value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\\s+/g, ' ')
        .trim();
    };
    const tokenize = (value) => normalizeText(value).split(' ').filter(Boolean);
    const hasWord = (value, word) => tokenize(value).includes(word);
    const normalizedTarget = TARGET_TRAITS.normalizedTarget;
    const normalizedTokens = TARGET_TRAITS.normalizedTokens;
    const targetWords = TARGET_TRAITS.targetWords;
    const desiredVersion = TARGET_TRAITS.desiredVersion;
    const wantsPro = TARGET_TRAITS.wantsPro;
    const wantsInstant = TARGET_TRAITS.wantsInstant;
    const wantsThinking = TARGET_TRAITS.wantsThinking;

    const detectCandidateVersion = (normalizedText, normalizedTestId) => {
      const combined = [normalizedText, normalizedTestId].filter(Boolean).join(' ');
      const has52 =
        combined.includes('5 2') ||
        combined.includes('5-2') ||
        combined.includes('5.2') ||
        combined.includes('gpt52');
      const has54 =
        combined.includes('5 4') ||
        combined.includes('5-4') ||
        combined.includes('5.4') ||
        combined.includes('gpt54');
      const has51 =
        combined.includes('5 1') ||
        combined.includes('5-1') ||
        combined.includes('5.1') ||
        combined.includes('gpt51');
      const has50 =
        combined.includes('5 0') ||
        combined.includes('5-0') ||
        combined.includes('5.0') ||
        combined.includes('gpt50');
      return has54 ? '5-4' : has52 ? '5-2' : has51 ? '5-1' : has50 ? '5-0' : null;
    };
    const hasVariant = (normalizedText, normalizedTestId, variant) =>
      hasWord(normalizedText, variant) || (normalizedTestId ?? '').toLowerCase().includes(variant);
    const optionMatchesTarget = (label, testid) => {
      const normalizedLabel = normalizeText(label);
      const normalizedTestId = (testid ?? '').toLowerCase();
      if (!normalizedLabel && !normalizedTestId) {
        return false;
      }
      const candidateVersion = detectCandidateVersion(normalizedLabel, normalizedTestId);
      if (desiredVersion && candidateVersion && candidateVersion !== desiredVersion) {
        return false;
      }
      const hasPro = hasVariant(normalizedLabel, normalizedTestId, 'pro');
      const hasThinking = hasVariant(normalizedLabel, normalizedTestId, 'thinking');
      const hasInstant = hasVariant(normalizedLabel, normalizedTestId, 'instant');
      if (wantsPro && !hasPro) return false;
      if (wantsThinking && !hasThinking) return false;
      if (wantsInstant && !hasInstant) return false;
      if (!wantsPro && hasPro) return false;
      if (!wantsThinking && hasThinking) return false;
      if (!wantsInstant && hasInstant) return false;
      if (!normalizedLabel) {
        return Boolean(candidateVersion && candidateVersion === desiredVersion);
      }
      if (candidateVersion && candidateVersion === desiredVersion) {
        return true;
      }
      if (normalizedLabel === normalizedTarget) {
        return true;
      }
      if (normalizedTarget && (normalizedLabel.startsWith(normalizedTarget) || normalizedLabel.includes(normalizedTarget))) {
        return true;
      }
      if (targetWords.length > 1 && targetWords.every((word) => normalizedLabel.includes(word))) {
        return true;
      }
      if (normalizedTokens.some((token) => token && normalizedLabel.includes(token))) {
        return true;
      }
      // ChatGPT sometimes abbreviates picker rows to the variant name only (e.g. "Pro", "Thinking").
      if (desiredVersion && !candidateVersion) {
        if (wantsPro && normalizedLabel === 'pro') return true;
        if (wantsThinking && normalizedLabel === 'thinking') return true;
        if (wantsInstant && normalizedLabel === 'instant') return true;
      }
      return Boolean(!desiredVersion && candidateVersion === null && normalizedLabel === normalizedTarget);
    };

    const button = document.querySelector(BUTTON_SELECTOR);
    if (!button) {
      return { status: 'button-missing' };
    }

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
    let lastPointerClick = 0;
    const pointerClick = () => {
      dispatchEscape();
      if (dispatchClickSequence(button)) {
        lastPointerClick = performance.now();
      }
    };

    const closeMenu = () => {
      try {
        if (dispatchClickSequence(button)) {
          lastPointerClick = performance.now();
          return;
        }
      } catch {}
      dispatchEscape();
    };

    const getButtonLabelCandidates = () => {
      const values = [
        button.textContent ?? '',
        button.getAttribute('aria-label') ?? '',
        button.getAttribute('title') ?? '',
        button.getAttribute('data-model') ?? '',
        button.getAttribute('data-value') ?? '',
      ]
        .map((value) => value.trim())
        .filter(Boolean);
      return Array.from(new Set(values));
    };
    const getButtonLabel = () => getButtonLabelCandidates()[0] ?? '';
    const buttonCandidateMatchesTarget = (candidate, testId) => {
      if (!optionMatchesTarget(candidate, testId)) {
        return false;
      }
      if (!desiredVersion) {
        return true;
      }
      const candidateVersion = detectCandidateVersion(normalizeText(candidate), (testId ?? '').toLowerCase());
      // A bare button label like "Pro" is ambiguous across versions; defer to selected menu option checks.
      if (!candidateVersion) {
        return false;
      }
      return candidateVersion === desiredVersion;
    };
    const buttonMatchesTarget = () => {
      const testId = button.getAttribute('data-testid') ?? '';
      return getButtonLabelCandidates().some((candidate) => buttonCandidateMatchesTarget(candidate, testId));
    };

    const getOptionLabel = (node) => node?.textContent?.trim() ?? '';
    const optionIsSelected = (node) => {
      if (!(node instanceof HTMLElement)) {
        return false;
      }
      const ariaChecked = node.getAttribute('aria-checked');
      const ariaSelected = node.getAttribute('aria-selected');
      const ariaCurrent = node.getAttribute('aria-current');
      const dataSelected = node.getAttribute('data-selected');
      const dataState = (node.getAttribute('data-state') ?? '').toLowerCase();
      const selectedStates = ['checked', 'selected', 'on', 'true'];
      if (ariaChecked === 'true' || ariaSelected === 'true' || ariaCurrent === 'true') {
        return true;
      }
      if (dataSelected === 'true' || selectedStates.includes(dataState)) {
        return true;
      }
      if (node.querySelector('[data-testid*="check"], [role="img"][data-icon="check"], svg[data-icon="check"]')) {
        return true;
      }
      return false;
    };
    const isVisibleMenuRoot = (root) => {
      if (!(root instanceof HTMLElement)) {
        return false;
      }
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return false;
      }
      const style = window.getComputedStyle(root);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const rootDistanceFromButton = (root) => {
      if (!(root instanceof HTMLElement)) {
        return Number.POSITIVE_INFINITY;
      }
      const buttonRect = button.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const buttonCenterX = buttonRect.left + buttonRect.width / 2;
      const buttonCenterY = buttonRect.top + buttonRect.height / 2;
      const rootCenterX = rootRect.left + rootRect.width / 2;
      const rootCenterY = rootRect.top + rootRect.height / 2;
      return Math.hypot(rootCenterX - buttonCenterX, rootCenterY - buttonCenterY);
    };
    const getAssociatedMenuRoots = () => {
      const menuRoots = Array.from(document.querySelectorAll(${menuContainerLiteral})).filter((root) =>
        isVisibleMenuRoot(root),
      );
      const controlledId = button.getAttribute('aria-controls') ?? '';
      const buttonId = button.id ?? '';
      const associatedVisibleRoots = menuRoots.filter((root) => {
        const rootId = root.id ?? '';
        const labelledBy = (root.getAttribute('aria-labelledby') ?? '').split(/\\s+/).filter(Boolean);
        if (controlledId && rootId === controlledId) {
          return true;
        }
        if (buttonId && labelledBy.includes(buttonId)) {
          return true;
        }
        return false;
      });
      if (associatedVisibleRoots.length > 0) {
        return associatedVisibleRoots;
      }
      const nearestVisibleRoot = menuRoots
        .slice()
        .sort((left, right) => rootDistanceFromButton(left) - rootDistanceFromButton(right))[0];
      return nearestVisibleRoot ? [nearestVisibleRoot] : [];
    };
    const collectOptionNodes = () => {
      const menuRoots = getAssociatedMenuRoots();
      const scoped = menuRoots.flatMap((root) => Array.from(root.querySelectorAll(${menuItemLiteral})));
      const fallback = Array.from(document.querySelectorAll(${menuItemLiteral}));
      const source = scoped.length > 0 ? scoped : fallback;
      return Array.from(new Set(source.filter((node) => node instanceof HTMLElement)));
    };
    const findSelectedOption = () => {
      let selected = null;
      for (const option of collectOptionNodes()) {
        if (!optionIsSelected(option)) {
          continue;
        }
        const label = getOptionLabel(option);
        const testid = option.getAttribute('data-testid') ?? '';
        if (optionMatchesTarget(label, testid)) {
          return { node: option, label, testid };
        }
        if (!selected) {
          selected = { node: option, label, testid };
        }
      }
      return selected;
    };
    const resolveCurrentSelectionLabel = () => {
      const selected = findSelectedOption();
      if (selected?.label) {
        return selected.label;
      }
      return getButtonLabel();
    };
    const selectionMatchesTarget = () => {
      const selected = findSelectedOption();
      if (selected) {
        return optionMatchesTarget(selected.label, selected.testid);
      }
      return buttonMatchesTarget();
    };

    const scoreOption = (normalizedText, testid) => {
      // Assign a score to every node so we can pick the most likely match without brittle equality checks.
      if (!normalizedText && !testid) {
        return 0;
      }
      let score = 0;
      const normalizedTestId = (testid ?? '').toLowerCase();
      const hasProVariant = hasVariant(normalizedText, normalizedTestId, 'pro');
      const hasThinkingVariant = hasVariant(normalizedText, normalizedTestId, 'thinking');
      const hasInstantVariant = hasVariant(normalizedText, normalizedTestId, 'instant');
      if (
        (wantsPro && !hasProVariant) ||
        (!wantsPro && hasProVariant) ||
        (wantsThinking && !hasThinkingVariant) ||
        (!wantsThinking && hasThinkingVariant) ||
        (wantsInstant && !hasInstantVariant) ||
        (!wantsInstant && hasInstantVariant)
      ) {
        return 0;
      }
      if (optionMatchesTarget(normalizedText, normalizedTestId)) {
        score += 600;
        if (normalizedText === 'pro' || normalizedText === 'thinking' || normalizedText === 'instant') {
          score += 400;
        }
      }
      if (normalizedTestId) {
        if (desiredVersion) {
          const candidateVersion = detectCandidateVersion('', normalizedTestId);
          // If a candidate advertises a different version, ignore it entirely.
          if (candidateVersion && candidateVersion !== desiredVersion) {
            return 0;
          }
          // When targeting an explicit version, avoid selecting submenu wrappers that can contain legacy models.
          if (normalizedTestId.includes('submenu') && candidateVersion === null) {
            return 0;
          }
        }
        // Exact testid matches take priority over substring matches
        const exactMatch = TEST_IDS.find((id) => id && normalizedTestId === id);
        if (exactMatch) {
          score += 1500;
          if (exactMatch.startsWith('model-switcher-')) score += 200;
        } else {
          const matches = TEST_IDS.filter((id) => id && normalizedTestId.includes(id));
          if (matches.length > 0) {
            // Prefer the most specific match (longest token) instead of treating any hit as equal.
            // This prevents generic tokens (e.g. "pro") from outweighing version-specific targets.
            const best = matches.reduce((acc, token) => (token.length > acc.length ? token : acc), '');
            score += 200 + Math.min(900, best.length * 25);
            if (best.startsWith('model-switcher-')) score += 120;
            if (best.includes('gpt-')) score += 60;
          }
        }
      }
      if (normalizedText && normalizedTarget) {
        if (normalizedText === normalizedTarget) {
          score += 500;
        } else if (normalizedText.startsWith(normalizedTarget)) {
          score += 420;
        } else if (normalizedText.includes(normalizedTarget)) {
          score += 380;
        }
      }
      for (const token of normalizedTokens) {
        // Reward partial matches to the expanded label/token set.
        if (token && normalizedText.includes(token)) {
          const tokenWeight = Math.min(120, Math.max(10, token.length * 4));
          score += tokenWeight;
        }
      }
      if (targetWords.length > 1) {
        let missing = 0;
        for (const word of targetWords) {
          if (!normalizedText.includes(word)) {
            missing += 1;
          }
        }
        score -= missing * 12;
      }
      // If the caller didn't explicitly ask for Pro, prefer non-Pro options when both exist.
      if (wantsPro) {
        if (!hasVariant(normalizedText, normalizedTestId, 'pro')) {
          score -= 80;
        }
      } else if (hasVariant(normalizedText, normalizedTestId, 'pro')) {
        score -= 40;
      }
      // Similarly for Thinking variant
      if (wantsThinking) {
        if (!hasVariant(normalizedText, normalizedTestId, 'thinking')) {
          score -= 80;
        }
      } else if (hasVariant(normalizedText, normalizedTestId, 'thinking')) {
        score -= 40;
      }
      // Similarly for Instant variant
      if (wantsInstant) {
        if (!hasVariant(normalizedText, normalizedTestId, 'instant')) {
          score -= 80;
        }
      } else if (hasVariant(normalizedText, normalizedTestId, 'instant')) {
        score -= 40;
      }
      return Math.max(score, 0);
    };

    const findBestOption = () => {
      // Walk through every menu item and keep whichever earns the highest score.
      let bestMatch = null;
      for (const option of collectOptionNodes()) {
        const text = option.textContent ?? '';
        const normalizedText = normalizeText(text);
        const testid = option.getAttribute('data-testid') ?? '';
        const score = scoreOption(normalizedText, testid);
        if (score <= 0) {
          continue;
        }
        const label = getOptionLabel(option);
        if (!bestMatch || score > bestMatch.score) {
          bestMatch = { node: option, label, score, testid, normalizedText };
        }
      }
      return bestMatch;
    };
    const clickedExactVersionedOption = (match) => {
      const normalizedTestId = (match?.testid ?? '').toLowerCase();
      if (!desiredVersion || !normalizedTestId.startsWith('model-switcher-')) {
        return false;
      }
      const candidateVersion = detectCandidateVersion('', normalizedTestId);
      if (!candidateVersion || candidateVersion !== desiredVersion) {
        return false;
      }
      if (wantsPro && !normalizedTestId.includes('pro')) return false;
      if (wantsThinking && !normalizedTestId.includes('thinking')) return false;
      if (wantsInstant && !normalizedTestId.includes('instant')) return false;
      return true;
    };
    const clickedVariantShortcutOption = (match) => {
      const normalizedLabel = normalizeText(match?.label ?? '');
      const normalizedTestId = (match?.testid ?? '').toLowerCase();
      if (!normalizedLabel || detectCandidateVersion(normalizedLabel, normalizedTestId)) {
        return false;
      }
      if (normalizedLabel === 'pro' || normalizedLabel.startsWith('pro ')) {
        return wantsPro && !wantsThinking && !wantsInstant;
      }
      if (normalizedLabel === 'thinking' || normalizedLabel.startsWith('thinking ')) {
        return wantsThinking && !wantsPro && !wantsInstant;
      }
      if (normalizedLabel === 'instant' || normalizedLabel.startsWith('instant ')) {
        return wantsInstant && !wantsPro && !wantsThinking;
      }
      return false;
    };
    const usesGenericModelButton = () => {
      const normalizedButtonLabel = normalizeText(getButtonLabel());
      return normalizedButtonLabel === 'chatgpt';
    };

    return new Promise((resolve) => {
      const start = performance.now();
      const detectTemporaryChat = () => {
        try {
          const url = new URL(window.location.href);
          const flag = (url.searchParams.get('temporary-chat') ?? '').toLowerCase();
          if (flag === 'true' || flag === '1' || flag === 'yes') return true;
        } catch {}
        const title = (document.title || '').toLowerCase();
        if (title.includes('temporary chat')) return true;
        const body = (document.body?.innerText || '').toLowerCase();
        return body.includes('temporary chat');
      };
      const collectAvailableOptions = () => {
        const menuRoots = getAssociatedMenuRoots();
        const nodes = menuRoots.length > 0
          ? menuRoots.flatMap((root) => Array.from(root.querySelectorAll(${menuItemLiteral})))
          : Array.from(document.querySelectorAll(${menuItemLiteral}));
        const labels = nodes
          .map((node) => (node?.textContent ?? '').trim())
          .filter(Boolean)
          .filter((label, index, arr) => arr.indexOf(label) === index);
        return labels.slice(0, 12);
      };
      const collectMenuLabels = () => collectAvailableOptions().map((label) => normalizeText(label));
      const looksLikeThinkingTimeMenu = () => {
        const labels = collectMenuLabels();
        return labels.includes('standard') && labels.includes('extended');
      };
      const dismissThinkingTimeMenu = () => {
        // Selecting Pro/Thinking can hand off to the thinking-time chooser.
        // Close that menu without mutating the current level.
        dispatchEscape();
        lastPointerClick = 0;
        return true;
      };
      const ensureMenuOpen = () => {
        const menuOpen = getAssociatedMenuRoots().length > 0;
        if (!menuOpen && performance.now() - lastPointerClick > REOPEN_INTERVAL_MS) {
          pointerClick();
        }
      };

      const openDelay = () => new Promise((r) => setTimeout(r, INITIAL_WAIT_MS));
      let initialized = false;
      let lastClickedSignature = '';
      let repeatedTargetClicks = 0;
      if (MODEL_STRATEGY === 'current') {
        const label = getButtonLabel();
        if (label) {
          resolve({ status: 'already-selected', label });
          return;
        }
      } else if (buttonMatchesTarget()) {
        resolve({ status: 'already-selected', label: getButtonLabel() || PRIMARY_LABEL });
        return;
      }
      if (getAssociatedMenuRoots().length === 0) {
        // Open once only when the model menu is not already visible.
        pointerClick();
      }
      const attempt = async () => {
        if (!initialized) {
          initialized = true;
          await openDelay();
        }
        ensureMenuOpen();
        if (MODEL_STRATEGY === 'current') {
          const label = resolveCurrentSelectionLabel();
          if (label) {
            closeMenu();
            resolve({ status: 'already-selected', label });
            return;
          }
          if (performance.now() - start > MAX_WAIT_MS) {
            closeMenu();
            resolve({ status: 'already-selected', label: getButtonLabel() });
            return;
          }
          setTimeout(attempt, REOPEN_INTERVAL_MS / 2);
          return;
        }
        if (selectionMatchesTarget()) {
          closeMenu();
          resolve({ status: 'already-selected', label: resolveCurrentSelectionLabel() });
          return;
        }
        const match = findBestOption();
        if (match) {
          if (optionIsSelected(match.node)) {
            closeMenu();
            resolve({ status: 'already-selected', label: resolveCurrentSelectionLabel() || match.label });
            return;
          }
          const signature = ((match.testid ?? '').toLowerCase()) + '|' + normalizeText(match.label);
          if (signature && signature === lastClickedSignature) {
            repeatedTargetClicks += 1;
          } else {
            lastClickedSignature = signature;
            repeatedTargetClicks = 1;
          }
          dispatchClickSequence(match.node);
          // Submenus (e.g. "Legacy models") need a second pass to pick the actual model option.
          // Keep scanning once the submenu opens instead of treating the submenu click as a final switch.
          const isSubmenu = (match.testid ?? '').toLowerCase().includes('submenu');
          if (isSubmenu) {
            setTimeout(attempt, REOPEN_INTERVAL_MS / 2);
            return;
          }
          // Wait for the top bar label to reflect the requested model; otherwise keep scanning.
          setTimeout(() => {
            if (selectionMatchesTarget()) {
              closeMenu();
              resolve({ status: 'switched', label: resolveCurrentSelectionLabel() || match.label });
              return;
            }
            if (buttonMatchesTarget()) {
              closeMenu();
              resolve({ status: 'switched', label: resolveCurrentSelectionLabel() || match.label });
              return;
            }
            if ((wantsPro || wantsThinking) && looksLikeThinkingTimeMenu()) {
              if (dismissThinkingTimeMenu()) {
                resolve({ status: 'switched', label: match.label || PRIMARY_LABEL });
                return;
              }
            }
            if (
              (clickedExactVersionedOption(match) || clickedVariantShortcutOption(match)) &&
              usesGenericModelButton() &&
              getAssociatedMenuRoots().length === 0
            ) {
              resolve({ status: 'switched', label: match.label || PRIMARY_LABEL });
              return;
            }
            if (repeatedTargetClicks >= 2) {
              closeMenu();
              resolve({
                status: 'option-not-found',
                hint: { temporaryChat: detectTemporaryChat(), availableOptions: collectAvailableOptions() },
              });
              return;
            }
            attempt();
          }, Math.max(120, INITIAL_WAIT_MS));
          return;
        }
        if (performance.now() - start > MAX_WAIT_MS) {
          resolve({
            status: 'option-not-found',
            hint: { temporaryChat: detectTemporaryChat(), availableOptions: collectAvailableOptions() },
          });
          return;
        }
        setTimeout(attempt, REOPEN_INTERVAL_MS / 2);
      };
      attempt();
    });
  })()`;
}

export function buildModelMatchersLiteralForTest(targetModel: string) {
  return buildModelMatchersLiteral(targetModel);
}

export function modelCandidateMatchesTargetForTest(
  targetModel: string,
  label: string,
  testId = "",
): boolean {
  return candidateMatchesTarget(buildModelTargetTraits(targetModel), label, testId);
}

function normalizeModelText(value: string | null | undefined): string {
  if (!value) {
    return "";
  }
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectModelVersion(text: string, testId = ""): ModelVersion | null {
  const normalizedText = normalizeModelText(text);
  const normalizedTestId = testId.toLowerCase();
  const combined = [normalizedText, normalizedTestId].filter(Boolean).join(" ");
  if (
    combined.includes("5 4") ||
    combined.includes("5-4") ||
    combined.includes("5.4") ||
    combined.includes("gpt54")
  ) {
    return "5-4";
  }
  if (
    combined.includes("5 2") ||
    combined.includes("5-2") ||
    combined.includes("5.2") ||
    combined.includes("gpt52")
  ) {
    return "5-2";
  }
  if (
    combined.includes("5 1") ||
    combined.includes("5-1") ||
    combined.includes("5.1") ||
    combined.includes("gpt51")
  ) {
    return "5-1";
  }
  if (
    combined.includes("5 0") ||
    combined.includes("5-0") ||
    combined.includes("5.0") ||
    combined.includes("gpt50")
  ) {
    return "5-0";
  }
  return null;
}

function hasVariantWord(text: string, testId: string, variant: "pro" | "thinking" | "instant") {
  const normalizedText = normalizeModelText(text);
  return normalizedText.split(" ").includes(variant) || testId.toLowerCase().includes(variant);
}

function buildModelTargetTraits(targetModel: string, labelTokens?: string[]): ModelTargetTraits {
  const normalizedTarget = normalizeModelText(targetModel);
  const normalizedTokens = Array.from(
    new Set([
      normalizedTarget,
      ...(labelTokens ?? buildModelMatchersLiteral(targetModel).labelTokens),
    ]),
  )
    .map((token) => normalizeModelText(token))
    .filter(Boolean);
  return {
    normalizedTarget,
    normalizedTokens,
    targetWords: normalizedTarget.split(" ").filter(Boolean),
    desiredVersion: detectModelVersion(normalizedTarget),
    wantsPro:
      normalizedTarget.split(" ").includes("pro") ||
      normalizedTokens.some((token) => token === "pro"),
    wantsInstant: normalizedTarget.split(" ").includes("instant"),
    wantsThinking: normalizedTarget.split(" ").includes("thinking"),
  };
}

function candidateMatchesTarget(
  traits: ModelTargetTraits,
  label: string | null | undefined,
  testId = "",
): boolean {
  const normalizedLabel = normalizeModelText(label);
  const normalizedTestId = testId.toLowerCase();
  if (!normalizedLabel && !normalizedTestId) {
    return false;
  }
  const candidateVersion = detectModelVersion(normalizedLabel, normalizedTestId);
  if (traits.desiredVersion && candidateVersion && candidateVersion !== traits.desiredVersion) {
    return false;
  }
  const hasPro = hasVariantWord(normalizedLabel, normalizedTestId, "pro");
  const hasThinking = hasVariantWord(normalizedLabel, normalizedTestId, "thinking");
  const hasInstant = hasVariantWord(normalizedLabel, normalizedTestId, "instant");
  if (traits.wantsPro && !hasPro) return false;
  if (traits.wantsThinking && !hasThinking) return false;
  if (traits.wantsInstant && !hasInstant) return false;
  if (!traits.wantsPro && hasPro) return false;
  if (!traits.wantsThinking && hasThinking) return false;
  if (!traits.wantsInstant && hasInstant) return false;
  if (!normalizedLabel) {
    return Boolean(candidateVersion && candidateVersion === traits.desiredVersion);
  }
  if (candidateVersion && candidateVersion === traits.desiredVersion) {
    return true;
  }
  if (normalizedLabel === traits.normalizedTarget) {
    return true;
  }
  if (
    traits.normalizedTarget &&
    (normalizedLabel.startsWith(traits.normalizedTarget) ||
      normalizedLabel.includes(traits.normalizedTarget))
  ) {
    return true;
  }
  if (
    traits.targetWords.length > 1 &&
    traits.targetWords.every((word) => normalizedLabel.includes(word))
  ) {
    return true;
  }
  if (traits.normalizedTokens.some((token) => token && normalizedLabel.includes(token))) {
    return true;
  }
  if (traits.desiredVersion && !candidateVersion) {
    if (traits.wantsPro && normalizedLabel === "pro") return true;
    if (traits.wantsThinking && normalizedLabel === "thinking") return true;
    if (traits.wantsInstant && normalizedLabel === "instant") return true;
  }
  return Boolean(
    !traits.desiredVersion &&
    candidateVersion === null &&
    normalizedLabel === traits.normalizedTarget,
  );
}

function buildModelMatchersLiteral(targetModel: string): {
  labelTokens: string[];
  testIdTokens: string[];
} {
  const base = targetModel.trim().toLowerCase();
  const labelTokens = new Set<string>();
  const testIdTokens = new Set<string>();

  const push = (value: string | null | undefined, set: Set<string>) => {
    const normalized = value?.trim();
    if (normalized) {
      set.add(normalized);
    }
  };

  push(base, labelTokens);
  push(base.replace(/\s+/g, " "), labelTokens);
  const collapsed = base.replace(/\s+/g, "");
  push(collapsed, labelTokens);
  const dotless = base.replace(/[.]/g, "");
  push(dotless, labelTokens);
  push(`chatgpt ${base}`, labelTokens);
  push(`chatgpt ${dotless}`, labelTokens);
  push(`gpt ${base}`, labelTokens);
  push(`gpt ${dotless}`, labelTokens);
  // Numeric variations (5.4 ↔ 54 ↔ gpt-5-4)
  if (base.includes("5.4") || base.includes("5-4") || base.includes("54")) {
    push("5.4", labelTokens);
    push("gpt-5.4", labelTokens);
    push("gpt5.4", labelTokens);
    push("gpt-5-4", labelTokens);
    push("gpt5-4", labelTokens);
    push("gpt54", labelTokens);
    push("chatgpt 5.4", labelTokens);
    if (!base.includes("pro")) {
      testIdTokens.add("model-switcher-gpt-5-4");
    }
    testIdTokens.add("gpt-5-4");
    testIdTokens.add("gpt5-4");
    testIdTokens.add("gpt54");
  }
  // Numeric variations (5.1 ↔ 51 ↔ gpt-5-1)
  if (base.includes("5.1") || base.includes("5-1") || base.includes("51")) {
    push("5.1", labelTokens);
    push("gpt-5.1", labelTokens);
    push("gpt5.1", labelTokens);
    push("gpt-5-1", labelTokens);
    push("gpt5-1", labelTokens);
    push("gpt51", labelTokens);
    push("chatgpt 5.1", labelTokens);
    testIdTokens.add("gpt-5-1");
    testIdTokens.add("gpt5-1");
    testIdTokens.add("gpt51");
  }
  // Numeric variations (5.0 ↔ 50 ↔ gpt-5-0)
  if (base.includes("5.0") || base.includes("5-0") || base.includes("50")) {
    push("5.0", labelTokens);
    push("gpt-5.0", labelTokens);
    push("gpt5.0", labelTokens);
    push("gpt-5-0", labelTokens);
    push("gpt5-0", labelTokens);
    push("gpt50", labelTokens);
    push("chatgpt 5.0", labelTokens);
    testIdTokens.add("gpt-5-0");
    testIdTokens.add("gpt5-0");
    testIdTokens.add("gpt50");
  }
  // Numeric variations (5.2 ↔ 52 ↔ gpt-5-2)
  if (base.includes("5.2") || base.includes("5-2") || base.includes("52")) {
    push("5.2", labelTokens);
    push("gpt-5.2", labelTokens);
    push("gpt5.2", labelTokens);
    push("gpt-5-2", labelTokens);
    push("gpt5-2", labelTokens);
    push("gpt52", labelTokens);
    push("chatgpt 5.2", labelTokens);
    // Thinking variant: explicit testid for "Thinking" picker option
    if (base.includes("thinking")) {
      push("thinking", labelTokens);
      testIdTokens.add("model-switcher-gpt-5-2-thinking");
      testIdTokens.add("gpt-5-2-thinking");
      testIdTokens.add("gpt-5.2-thinking");
    }
    // Instant variant: explicit testid for "Instant" picker option
    if (base.includes("instant")) {
      push("instant", labelTokens);
      testIdTokens.add("model-switcher-gpt-5-2-instant");
      testIdTokens.add("gpt-5-2-instant");
      testIdTokens.add("gpt-5.2-instant");
    }
    // Base 5.2 testids (for "Auto" mode when no suffix specified)
    if (!base.includes("thinking") && !base.includes("instant") && !base.includes("pro")) {
      testIdTokens.add("model-switcher-gpt-5-2");
    }
    testIdTokens.add("gpt-5-2");
    testIdTokens.add("gpt5-2");
    testIdTokens.add("gpt52");
  }
  // Pro / research variants
  if (base.includes("pro")) {
    push("proresearch", labelTokens);
    push("research grade", labelTokens);
    push("advanced reasoning", labelTokens);
    if (base.includes("5.4") || base.includes("5-4") || base.includes("54")) {
      testIdTokens.add("gpt-5.4-pro");
      testIdTokens.add("gpt-5-4-pro");
      testIdTokens.add("gpt54pro");
    }
    if (base.includes("5.1") || base.includes("5-1") || base.includes("51")) {
      testIdTokens.add("gpt-5.1-pro");
      testIdTokens.add("gpt-5-1-pro");
      testIdTokens.add("gpt51pro");
    }
    if (base.includes("5.0") || base.includes("5-0") || base.includes("50")) {
      testIdTokens.add("gpt-5.0-pro");
      testIdTokens.add("gpt-5-0-pro");
      testIdTokens.add("gpt50pro");
    }
    if (base.includes("5.2") || base.includes("5-2") || base.includes("52")) {
      testIdTokens.add("gpt-5.2-pro");
      testIdTokens.add("gpt-5-2-pro");
      testIdTokens.add("gpt52pro");
    }
    testIdTokens.add("pro");
    testIdTokens.add("proresearch");
  }
  base
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .forEach((token) => {
      push(token, labelTokens);
    });

  const hyphenated = base.replace(/\s+/g, "-");
  push(hyphenated, testIdTokens);
  push(collapsed, testIdTokens);
  push(dotless, testIdTokens);
  // data-testid values observed in the ChatGPT picker (e.g., model-switcher-gpt-5.1-pro)
  push(`model-switcher-${hyphenated}`, testIdTokens);
  push(`model-switcher-${collapsed}`, testIdTokens);
  push(`model-switcher-${dotless}`, testIdTokens);

  if (!labelTokens.size) {
    labelTokens.add(base);
  }
  if (!testIdTokens.size) {
    testIdTokens.add(base.replace(/\s+/g, "-"));
  }

  return {
    labelTokens: Array.from(labelTokens).filter(Boolean),
    testIdTokens: Array.from(testIdTokens).filter(Boolean),
  };
}

export function buildModelSelectionExpressionForTest(targetModel: string): string {
  return buildModelSelectionExpression(targetModel, "select");
}
