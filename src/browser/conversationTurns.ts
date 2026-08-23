import { createHash } from "node:crypto";
import type { ChromeClient } from "./types.js";
import {
  CONVERSATION_TURN_CONTAINER_SELECTOR,
  CONVERSATION_TURN_SELECTOR,
  FINISHED_ACTIONS_SELECTOR,
} from "./constants.js";

export interface ConversationTurnBinding {
  promptDigest?: string;
  promptTurnIndex?: number;
  promptTurnId?: string;
  promptMessageId?: string;
  assistantTurnIndex?: number;
  assistantTurnId?: string;
  assistantMessageId?: string;
}

export interface ConversationUserTurn {
  index: number;
  text: string;
  turnId?: string;
  messageId?: string;
}

export interface BoundConversationTurn {
  user: ConversationUserTurn;
  assistant?: {
    index: number;
    text: string;
    html?: string;
    turnId?: string;
    messageId?: string;
    completionVisible?: boolean;
  };
  hasLaterUserTurn: boolean;
}

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

export function buildConversationTurnCountExpression(rootExpression = "document"): string {
  return `(${buildConversationTurnListExpression(rootExpression)}).length`;
}

export function normalizeConversationTurnText(text: string): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

export function hashConversationTurnText(text: string): string {
  return createHash("sha256").update(normalizeConversationTurnText(text), "utf8").digest("hex");
}

export async function readConversationUserTurns(
  Runtime: ChromeClient["Runtime"],
): Promise<ConversationUserTurn[]> {
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const roleOf = (node) => normalize(
        node?.getAttribute?.('data-message-author-role') ||
        node?.getAttribute?.('data-turn') ||
        node?.dataset?.turn ||
        '',
      ).toLowerCase();
      const isUser = (node) =>
        roleOf(node) === 'user' ||
        Boolean(node?.querySelector?.('[data-message-author-role="user"], [data-turn="user"]'));
      const messageRoot = (node) =>
        node?.matches?.('[data-message-id]')
          ? node
          : node?.querySelector?.('[data-message-id]');
      const userTextRoot = (node) =>
        node?.querySelector?.('[data-testid="collapsible-user-message-content"]') || node;
      const turns = ${buildConversationTurnListExpression()};
      return turns.flatMap((node, index) => {
        if (!isUser(node)) return [];
        const message = messageRoot(node);
        const content = userTextRoot(node);
        return [{
          index,
          text: normalize(content?.innerText || content?.textContent || ''),
          turnId: node?.getAttribute?.('data-testid') || message?.getAttribute?.('data-testid') || null,
          messageId: message?.getAttribute?.('data-message-id') || node?.getAttribute?.('data-message-id') || null,
        }];
      });
    })()`,
    returnByValue: true,
  });
  if (!Array.isArray(result?.value)) return [];
  return result.value.flatMap((candidate): ConversationUserTurn[] => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const value = candidate as Record<string, unknown>;
    if (typeof value.index !== "number" || !Number.isInteger(value.index) || value.index < 0) {
      return [];
    }
    return [
      {
        index: value.index,
        text: typeof value.text === "string" ? value.text : "",
        ...(typeof value.turnId === "string" && value.turnId ? { turnId: value.turnId } : {}),
        ...(typeof value.messageId === "string" && value.messageId
          ? { messageId: value.messageId }
          : {}),
      },
    ];
  });
}

export function resolveConversationUserTurnBinding(
  binding: ConversationTurnBinding,
  turns: ConversationUserTurn[],
): { status: "matched"; user: ConversationUserTurn } | { status: "missing" | "ambiguous" } {
  const hasBinding = Boolean(
    binding.promptDigest ||
    binding.promptTurnId ||
    binding.promptMessageId ||
    (typeof binding.promptTurnIndex === "number" && Number.isInteger(binding.promptTurnIndex)),
  );
  if (!hasBinding) return { status: "missing" };
  const matches = turns.filter((turn) => {
    if (binding.promptMessageId && turn.messageId !== binding.promptMessageId) return false;
    if (binding.promptTurnId && turn.turnId !== binding.promptTurnId) return false;
    if (
      typeof binding.promptTurnIndex === "number" &&
      Number.isInteger(binding.promptTurnIndex) &&
      turn.index !== binding.promptTurnIndex
    ) {
      return false;
    }
    if (binding.promptDigest && hashConversationTurnText(turn.text) !== binding.promptDigest) {
      return false;
    }
    return true;
  });
  if (matches.length === 1) return { status: "matched", user: matches[0] as ConversationUserTurn };
  return { status: matches.length > 1 ? "ambiguous" : "missing" };
}

export async function captureConversationUserTurnBinding(
  Runtime: ChromeClient["Runtime"],
  prompt: string,
  minTurnIndex = 0,
  options: { expectedTurnIndex?: number; attachmentNames?: string[] } = {},
): Promise<ConversationTurnBinding | null> {
  const expected = normalizeConversationTurnMatchText(prompt);
  if (!expected) return null;
  const expectedTurnIndex = options.expectedTurnIndex;
  const attachmentNames = (options.attachmentNames ?? [])
    .map((name) => normalizeConversationTurnMatchText(name))
    .filter(Boolean);
  const matches = (await readConversationUserTurns(Runtime)).filter((turn) => {
    if (turn.index < minTurnIndex) return false;
    if (Number.isInteger(expectedTurnIndex) && turn.index !== expectedTurnIndex) {
      return false;
    }
    const observed = normalizeConversationTurnMatchText(turn.text);
    return matchesSubmittedPrompt(observed, expected, attachmentNames);
  });
  if (matches.length !== 1) return null;
  const user = matches[0] as ConversationUserTurn;
  return {
    promptDigest: hashConversationTurnText(user.text),
    promptTurnIndex: user.index,
    ...(user.turnId ? { promptTurnId: user.turnId } : {}),
    ...(user.messageId ? { promptMessageId: user.messageId } : {}),
  };
}

function normalizeConversationTurnMatchText(text: string): string {
  return normalizeConversationTurnText(text)
    .replace(/```[^\n]*\n([\s\S]*?)```/gu, " $1 ")
    .replace(/```/gu, " ")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function matchesSubmittedPrompt(
  observed: string,
  expected: string,
  attachmentNames: string[],
): boolean {
  if (observed === expected) return true;
  if (!observed.endsWith(expected) || attachmentNames.length === 0) return false;
  const prefix = observed.slice(0, -expected.length).toLocaleLowerCase();
  return attachmentNames.every((name) => prefix.includes(name.toLocaleLowerCase()));
}

export async function captureLatestConversationUserTurnBinding(
  Runtime: ChromeClient["Runtime"],
  minTurnIndex = 0,
): Promise<ConversationTurnBinding | null> {
  const turns = await readConversationUserTurns(Runtime);
  let user: ConversationUserTurn | undefined;
  for (const turn of turns) {
    if (turn.index >= minTurnIndex) user = turn;
  }
  if (!user?.text) return null;
  return {
    promptDigest: hashConversationTurnText(user.text),
    promptTurnIndex: user.index,
    ...(user.turnId ? { promptTurnId: user.turnId } : {}),
    ...(user.messageId ? { promptMessageId: user.messageId } : {}),
  };
}

export async function readBoundConversationTurn(
  Runtime: ChromeClient["Runtime"],
  binding: ConversationTurnBinding,
): Promise<
  { status: "matched"; turn: BoundConversationTurn } | { status: "missing" | "ambiguous" }
> {
  const finishedSelector = JSON.stringify(FINISHED_ACTIONS_SELECTOR);
  const { result } = await Runtime.evaluate({
    expression: `(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const roleOf = (node) => normalize(
        node?.getAttribute?.('data-message-author-role') ||
        node?.getAttribute?.('data-turn') ||
        node?.dataset?.turn ||
        '',
      ).toLowerCase();
      const isUser = (node) =>
        roleOf(node) === 'user' ||
        Boolean(node?.querySelector?.('[data-message-author-role="user"], [data-turn="user"]'));
      const isAssistant = (node) =>
        roleOf(node) === 'assistant' ||
        Boolean(node?.querySelector?.('[data-message-author-role="assistant"], [data-turn="assistant"], [data-testid*="assistant"]'));
      const messageRoot = (node) =>
        node?.matches?.('[data-message-id]')
          ? node
          : node?.querySelector?.('[data-message-id]');
      const userTextRoot = (node) =>
        node?.querySelector?.('[data-testid="collapsible-user-message-content"]') || node;
      const turns = ${buildConversationTurnListExpression()};
      const candidates = [];
      for (let userIndex = 0; userIndex < turns.length; userIndex += 1) {
        const userNode = turns[userIndex];
        if (!isUser(userNode)) continue;
        const userMessage = messageRoot(userNode);
        const userContent = userTextRoot(userNode);
        const assistants = [];
        let hasLaterUserTurn = false;
        for (let index = userIndex + 1; index < turns.length; index += 1) {
          const node = turns[index];
          if (isUser(node)) {
            hasLaterUserTurn = true;
            break;
          }
          if (!isAssistant(node)) continue;
          const message = messageRoot(node);
          const content =
            node.querySelector?.('.markdown,[data-message-content],[data-testid*="message"],.prose,[class*="markdown"]') ||
            node;
          assistants.push({
            index,
            text: normalize(content?.innerText || content?.textContent || ''),
            html: content?.innerHTML || '',
            turnId: node.getAttribute?.('data-testid') || message?.getAttribute?.('data-testid') || null,
            messageId: message?.getAttribute?.('data-message-id') || node.getAttribute?.('data-message-id') || null,
            completionVisible: Boolean(node.querySelector?.(${finishedSelector})) ||
              Array.from(node.querySelectorAll?.('.markdown') || []).some(
                (markdown) => normalize(markdown?.textContent) === 'Done',
              ),
          });
        }
        candidates.push({
          user: {
            index: userIndex,
            text: normalize(userContent?.innerText || userContent?.textContent || ''),
            turnId: userNode?.getAttribute?.('data-testid') || userMessage?.getAttribute?.('data-testid') || null,
            messageId: userMessage?.getAttribute?.('data-message-id') || userNode?.getAttribute?.('data-message-id') || null,
          },
          assistants,
          hasLaterUserTurn,
        });
      }
      return candidates;
    })()`,
    returnByValue: true,
  });
  if (!Array.isArray(result?.value)) return { status: "missing" };
  const candidates = result.value.flatMap(
    (
      candidate,
    ): Array<{
      user: ConversationUserTurn;
      assistants: NonNullable<BoundConversationTurn["assistant"]>[];
      hasLaterUserTurn: boolean;
    }> => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
      const value = candidate as Record<string, unknown>;
      const rawUser = value.user;
      if (!rawUser || typeof rawUser !== "object" || Array.isArray(rawUser)) return [];
      const userValue = rawUser as Record<string, unknown>;
      if (
        typeof userValue.index !== "number" ||
        !Number.isInteger(userValue.index) ||
        userValue.index < 0
      ) {
        return [];
      }
      const user: ConversationUserTurn = {
        index: userValue.index,
        text: typeof userValue.text === "string" ? userValue.text : "",
        ...(typeof userValue.turnId === "string" && userValue.turnId
          ? { turnId: userValue.turnId }
          : {}),
        ...(typeof userValue.messageId === "string" && userValue.messageId
          ? { messageId: userValue.messageId }
          : {}),
      };
      const assistants = Array.isArray(value.assistants)
        ? value.assistants.flatMap(
            (rawAssistant): NonNullable<BoundConversationTurn["assistant"]>[] => {
              if (
                !rawAssistant ||
                typeof rawAssistant !== "object" ||
                Array.isArray(rawAssistant)
              ) {
                return [];
              }
              const assistantValue = rawAssistant as Record<string, unknown>;
              if (
                typeof assistantValue.index !== "number" ||
                !Number.isInteger(assistantValue.index) ||
                assistantValue.index < 0
              ) {
                return [];
              }
              return [
                {
                  index: assistantValue.index,
                  text: typeof assistantValue.text === "string" ? assistantValue.text : "",
                  ...(assistantValue.completionVisible === true ? { completionVisible: true } : {}),
                  ...(typeof assistantValue.html === "string" && assistantValue.html
                    ? { html: assistantValue.html }
                    : {}),
                  ...(typeof assistantValue.turnId === "string" && assistantValue.turnId
                    ? { turnId: assistantValue.turnId }
                    : {}),
                  ...(typeof assistantValue.messageId === "string" && assistantValue.messageId
                    ? { messageId: assistantValue.messageId }
                    : {}),
                },
              ];
            },
          )
        : [];
      return [{ user, assistants, hasLaterUserTurn: value.hasLaterUserTurn === true }];
    },
  );
  const resolved = resolveConversationUserTurnBinding(
    binding,
    candidates.map((candidate) => candidate.user),
  );
  if (resolved.status !== "matched") return resolved;
  const matched = candidates.find((candidate) => candidate.user === resolved.user);
  if (!matched) return { status: "missing" };
  const hasAssistantBinding = Boolean(
    binding.assistantTurnId ||
    binding.assistantMessageId ||
    (typeof binding.assistantTurnIndex === "number" &&
      Number.isInteger(binding.assistantTurnIndex)),
  );
  const assistantMatches = hasAssistantBinding
    ? matched.assistants.filter((assistant) => {
        if (binding.assistantMessageId && assistant.messageId !== binding.assistantMessageId) {
          return false;
        }
        if (binding.assistantTurnId && assistant.turnId !== binding.assistantTurnId) return false;
        if (
          typeof binding.assistantTurnIndex === "number" &&
          Number.isInteger(binding.assistantTurnIndex) &&
          assistant.index !== binding.assistantTurnIndex
        ) {
          return false;
        }
        return true;
      })
    : matched.assistants;
  if (assistantMatches.length > 1) return { status: "ambiguous" };
  if (hasAssistantBinding && assistantMatches.length === 0) return { status: "missing" };
  return {
    status: "matched",
    turn: {
      user: matched.user,
      assistant: assistantMatches[0],
      hasLaterUserTurn: matched.hasLaterUserTurn,
    },
  };
}
