import {
  ASSISTANT_ROLE_SELECTOR,
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
} from "./constants.js";

/** Build a browser-context expression that returns one DOM node per conversation turn. */
export function buildConversationTurnListExpression(rootExpression = "document"): string {
  const containerSelector = JSON.stringify(CONVERSATION_TURN_CONTAINER_SELECTOR);
  const fallbackSelector = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  return `(() => {
    const root = ${rootExpression};
    const containers = Array.from(root.querySelectorAll(${containerSelector}));
    return containers.length > 0
      ? containers
      : Array.from(root.querySelectorAll(${fallbackSelector}));
  })()`;
}

/** Inject the canonical browser-side turn roles and stable-identity readers. */
export function buildConversationTurnIdentityExpression(): string {
  const userSelector = JSON.stringify('[data-message-author-role="user"], [data-turn="user"]');
  const assistantSelector = JSON.stringify(ASSISTANT_ROLE_SELECTOR);
  return `const USER_TURN_SELECTOR = ${userSelector};
    const ASSISTANT_TURN_SELECTOR = ${assistantSelector};
    const readTurnRole = (node) => String(
      node?.getAttribute?.('data-message-author-role') ||
        node?.getAttribute?.('data-turn') ||
        node?.dataset?.turn ||
        node?.dataset?.messageAuthorRole ||
        '',
    ).toLowerCase();
    const isUserTurn = (node) =>
      readTurnRole(node) === 'user' || Boolean(node?.querySelector?.(USER_TURN_SELECTOR));
    const isAssistantTurn = (node) => {
      if (!node) return false;
      if (readTurnRole(node) === 'assistant') return true;
      const testId = String(node.getAttribute?.('data-testid') || '').toLowerCase();
      return testId.includes('assistant') ||
        (testId.includes('conversation-turn') && /chatgpt\\s+said/i.test(node?.innerText || node?.textContent || '')) ||
        Boolean(
          node.querySelector?.(ASSISTANT_TURN_SELECTOR) || node.querySelector?.('[data-testid*="assistant"]'),
        );
    };
    const readTurnId = (node) => {
      const testId = node?.getAttribute?.('data-testid');
      const value =
        node?.getAttribute?.('data-turn-id') ||
        node?.dataset?.turnId ||
        (String(testId || '').startsWith('conversation-turn-') ? testId : '') ||
        (String(node?.id || '').startsWith('conversation-turn-') ? node.id : '');
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };
    const readMessageId = (node) => {
      const messageNode = node?.matches?.('[data-message-id]')
        ? node
        : node?.querySelector?.('[data-message-id]');
      const value = messageNode?.getAttribute?.('data-message-id') || messageNode?.dataset?.messageId;
      return typeof value === 'string' && value.trim() ? value.trim() : null;
    };`;
}

export function buildConversationTurnCountExpression(rootExpression = "document"): string {
  return `(${buildConversationTurnListExpression(rootExpression)}).length`;
}
