import { CONVERSATION_TURN_SELECTOR } from "./constants.js";

export function buildThreadIntrospectionHelpers(): string {
  const conversationSelectorLiteral = JSON.stringify(CONVERSATION_TURN_SELECTOR);
  return `const __oracleThreadSelector = '[data-testid^="conversation-turn"], [data-message-author-role], [data-turn]';
const __oracleIsElement = (node) =>
  Boolean(node && typeof node === 'object' && typeof node.querySelectorAll === 'function');
const __oracleIsExcluded = (node) =>
  Boolean(
    node?.closest?.(
      'nav,aside,form,[data-testid*="sidebar"],[data-testid*="chat-history"],[data-testid*="composer"]',
    ),
  );
const __oracleThreadText = (node) => {
  if (!__oracleIsElement(node)) return '';
  const source = typeof node.cloneNode === 'function' ? node.cloneNode(true) : node;
  if (__oracleIsElement(source)) {
    const discardSelector = [
      'nav',
      'aside',
      'form',
      '[aria-label="Response actions"]',
      '[role="group"][aria-label="Response actions"]',
      '[data-testid*="copy-turn-action-button"]',
      '[data-testid*="good-response-turn-action-button"]',
      '[data-testid*="bad-response-turn-action-button"]',
      '[data-testid*="turn-action"]',
      '[data-testid*="message-actions"]',
      'button[aria-label="Share"]',
    ].join(',');
    for (const child of Array.from(source.querySelectorAll(discardSelector))) {
      child?.remove?.();
    }
  }
  return String(source?.innerText || source?.textContent || '').trim();
};
const __oracleThreadRole = (node) => {
  const own =
    String(node?.getAttribute?.('data-message-author-role') || node?.getAttribute?.('data-turn') || '')
      .toLowerCase()
      .trim();
  if (own === 'user' || own === 'assistant') return own;
  const nested = node?.querySelector?.('[data-message-author-role], [data-turn]');
  const nestedRole = String(
    nested?.getAttribute?.('data-message-author-role') || nested?.getAttribute?.('data-turn') || '',
  )
    .toLowerCase()
    .trim();
  if (nestedRole === 'user' || nestedRole === 'assistant') return nestedRole;
  const label = String(node?.querySelector?.('h4')?.innerText || '').toLowerCase().trim();
  if (label.startsWith('you said')) return 'user';
  if (label.includes('chatgpt said')) return 'assistant';
  return '';
};
const __oraclePickThreadRoot = () => {
  const roots = [
    document.querySelector('section[data-testid="screen-threadFlyOut"]'),
    document.querySelector('[data-testid="chat-thread"]'),
    document.querySelector('main'),
    document.querySelector('[role="main"]'),
    document.body,
  ].filter(__oracleIsElement);
  const score = (node) => {
    const conversationTurns = node.querySelectorAll('[data-testid^="conversation-turn"]').length;
    const roleTurns = node.querySelectorAll('[data-message-author-role], [data-turn]').length;
    const markdowns = node.querySelectorAll(
      '.markdown,[data-message-content],[data-testid*="message"],.prose,[class*="markdown"]',
    ).length;
    return conversationTurns * 100 + roleTurns * 10 + markdowns;
  };
  let best = roots[0] || document.body;
  let bestScore = best ? score(best) : 0;
  for (const candidate of roots.slice(1)) {
    const candidateScore = score(candidate);
    if (candidateScore > bestScore) {
      best = candidate;
      bestScore = candidateScore;
    }
  }
  return best || document.body;
};
const __oracleCollectThreadEntries = (root) => {
  const scope = __oracleIsElement(root) ? root : __oraclePickThreadRoot();
  if (!__oracleIsElement(scope)) return [];
  const candidates = [];
  for (const node of Array.from(scope.querySelectorAll(__oracleThreadSelector))) {
    if (!__oracleIsElement(node) || __oracleIsExcluded(node)) continue;
    const container =
      node.closest?.('[data-testid^="conversation-turn"]') ||
      node.closest?.('[data-message-author-role], [data-turn]') ||
      node;
    if (!__oracleIsElement(container) || __oracleIsExcluded(container)) continue;
    if (typeof scope.contains === 'function' && !scope.contains(container)) continue;
    if (!candidates.includes(container)) {
      candidates.push(container);
    }
  }
  const topLevel = candidates.filter(
    (node, index) =>
      !candidates.some(
        (other, otherIndex) =>
          otherIndex !== index && typeof other.contains === 'function' && other.contains(node),
      ),
  );
  return topLevel.map((node) => ({
    role: __oracleThreadRole(node),
    text: __oracleThreadText(node),
    conversationMatch: Boolean(node?.closest?.(${conversationSelectorLiteral}) || node?.matches?.(${conversationSelectorLiteral})),
  }));
};`;
}
