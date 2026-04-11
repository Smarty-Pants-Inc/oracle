import type { ChromeClient, BrowserLogger } from "./types.js";
import { CONVERSATION_TURN_SELECTOR } from "./constants.js";

export function buildConversationDebugExpression(): string {
  return `(() => {
    const CONVERSATION_SELECTOR = ${JSON.stringify(CONVERSATION_TURN_SELECTOR)};
    const turns = Array.from(document.querySelectorAll(CONVERSATION_SELECTOR));
    return turns.map((node) => ({
      role: node.getAttribute('data-message-author-role'),
      text: node.innerText?.slice(0, 200),
      testid: node.getAttribute('data-testid'),
    }));
  })()`;
}

function buildUiDebugExpression(): string {
  return `(() => {
    const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const menuButtons = Array.from(document.querySelectorAll('[aria-haspopup="menu"]'))
      .filter(isVisible)
      .slice(0, 12)
      .map((node) => ({
        text: normalize(node.textContent),
        aria: normalize(node.getAttribute('aria-label')),
        testid: normalize(node.getAttribute('data-testid')),
        className: normalize(node.className),
      }));
    const visibleMenus = Array.from(
      document.querySelectorAll('[role="menu"], [role="group"], [data-radix-collection-root]'),
    )
      .filter(isVisible)
      .slice(0, 8)
      .map((node) => ({
        role: node.getAttribute('role'),
        aria: normalize(node.getAttribute('aria-label')),
        text: normalize(node.textContent).slice(0, 200),
      }));
    return {
      title: document.title,
      url: location.href,
      menuButtons,
      visibleMenus,
    };
  })()`;
}

export async function logConversationSnapshot(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
) {
  const expression = buildConversationDebugExpression();
  const { result } = await Runtime.evaluate({ expression, returnByValue: true });
  if (Array.isArray(result.value)) {
    const recent = (result.value as Array<Record<string, unknown>>).slice(-3);
    logger(`Conversation snapshot: ${JSON.stringify(recent)}`);
  }
}

export async function logDomFailure(
  Runtime: ChromeClient["Runtime"],
  logger: BrowserLogger,
  context: string,
) {
  if (!logger?.verbose) {
    return;
  }
  try {
    const entry = `Browser automation failure (${context}); capturing DOM snapshot for debugging...`;
    logger(entry);
    if (logger.sessionLog && logger.sessionLog !== logger) {
      logger.sessionLog(entry);
    }
    await logConversationSnapshot(Runtime, logger);
    const { result } = await Runtime.evaluate({
      expression: buildUiDebugExpression(),
      returnByValue: true,
    });
    if (result.value) {
      logger(`UI snapshot: ${JSON.stringify(result.value)}`);
    }
  } catch {
    // ignore snapshot failures
  }
}
