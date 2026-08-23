import type { ChromeClient } from "./types.js";
import { withTimeout } from "./reattachHelpers.js";

export interface ChatGptAccountIdentity {
  accountDigest: string;
  email: string;
}

export const MAX_CHATGPT_ACCOUNT_ID_LENGTH = 512;
export const MAX_CHATGPT_ACCOUNT_EMAIL_LENGTH = 320;
export const MAX_CHATGPT_JWT_SEGMENT_LENGTH = 8_192;

const CHATGPT_EMAIL_PATTERN =
  /^[^@\s]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeChatGptAccountEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email.length <= MAX_CHATGPT_ACCOUNT_EMAIL_LENGTH && CHATGPT_EMAIL_PATTERN.test(email)
    ? email
    : undefined;
}

export function normalizeChatGptAccountDigest(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const digest = value.trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(digest) ? digest : undefined;
}

export interface EvaluatedChatGptPageAffinity {
  expectedConversationId?: string;
  expectedAccountDigest?: string;
}

export function buildEvaluatedChatGptPageAffinityGuard({
  expectedConversationId,
  expectedAccountDigest,
}: EvaluatedChatGptPageAffinity): string {
  const conversationId = expectedConversationId?.trim() || undefined;
  const accountDigest = normalizeChatGptAccountDigest(expectedAccountDigest);
  if (expectedAccountDigest !== undefined && !accountDigest) {
    throw new Error("Expected ChatGPT account affinity is invalid.");
  }
  if (!conversationId && !accountDigest) return "";

  return `
    const assertOracleChatGptPageAffinity = async () => {
      let pageUrl;
      try {
        pageUrl = new URL(location.href);
      } catch {
        throw new Error('ChatGPT page origin is unavailable.');
      }
      if (pageUrl.origin !== ${JSON.stringify(CHATGPT_ORIGIN)}) {
        throw new Error('ChatGPT page origin changed.');
      }
      const expectedConversationId = ${JSON.stringify(conversationId ?? null)};
      const conversationMatch = /^(?:\\/c|\\/g\\/[^/?#]+\\/(?:project\\/)?c)\\/([a-zA-Z0-9-]+)\\/?$/.exec(pageUrl.pathname);
      if (expectedConversationId && conversationMatch?.[1] !== expectedConversationId) {
        throw new Error('ChatGPT conversation changed.');
      }
      const expectedAccountDigest = ${JSON.stringify(accountDigest ?? null)};
      if (!expectedAccountDigest) return;
      const target = ${JSON.stringify(CHATGPT_SESSION_URL)};
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ${DEFAULT_ACCOUNT_IDENTITY_TIMEOUT_MS});
      try {
        const response = await fetch(target, {
          method: 'GET', cache: 'no-store', credentials: 'include', redirect: 'error', signal: controller.signal,
        });
        if (!response.ok || response.redirected || response.url !== target || controller.signal.aborted) {
          throw new Error('Authenticated ChatGPT account identity is unavailable.');
        }
        const body = await response.json();
        const rawUserId = typeof body?.user?.id === 'string' ? body.user.id.trim() : '';
        if (!rawUserId || rawUserId.length > ${MAX_CHATGPT_ACCOUNT_ID_LENGTH} || !globalThis.crypto?.subtle) {
          throw new Error('Authenticated ChatGPT account identity is unavailable.');
        }
        const bytes = new Uint8Array(await crypto.subtle.digest(
          'SHA-256', new TextEncoder().encode(rawUserId),
        ));
        const observedAccountDigest = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
        if (observedAccountDigest !== expectedAccountDigest) {
          throw new Error('ChatGPT account identity changed.');
        }
      } finally {
        clearTimeout(timeout);
      }
    };`;
}

const DEFAULT_ACCOUNT_IDENTITY_TIMEOUT_MS = 10_000;
const ACCOUNT_IDENTITY_TIMEOUT_ERROR =
  "Timed out while reading authenticated ChatGPT account identity.";
const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_SESSION_URL = `${CHATGPT_ORIGIN}/api/auth/session`;

/** Reads only the authenticated user id digest and normalized email from ChatGPT's page context. */
export async function readChatGptAccountIdentity(
  Runtime: ChromeClient["Runtime"],
  remainingMs?: number,
): Promise<ChatGptAccountIdentity> {
  const timeoutMs =
    typeof remainingMs === "number" && Number.isFinite(remainingMs)
      ? Math.max(0, remainingMs)
      : DEFAULT_ACCOUNT_IDENTITY_TIMEOUT_MS;
  if (timeoutMs <= 0) {
    throw new Error(ACCOUNT_IDENTITY_TIMEOUT_ERROR);
  }
  const outcome = await withTimeout(
    Runtime.evaluate({
      expression: `(() => (async () => {
        const timeoutMs = ${JSON.stringify(timeoutMs)};
        const target = ${JSON.stringify(CHATGPT_SESSION_URL)};
        let timeout;
        try {
          if (new URL(location.href).origin !== ${JSON.stringify(CHATGPT_ORIGIN)}) return null;
          const controller = new AbortController();
          timeout = setTimeout(() => controller.abort(), timeoutMs);
          const response = await fetch(target, {
            method: 'GET', cache: 'no-store', credentials: 'include', redirect: 'error', signal: controller.signal,
          });
          if (
            !response.ok ||
            response.redirected ||
            response.url !== target ||
            controller.signal.aborted
          ) return null;
          const body = await response.json();
          const rawUserId = typeof body?.user?.id === 'string' ? body.user.id.trim() : '';
          const rawEmail = typeof body?.user?.email === 'string'
            ? body.user.email.trim().toLowerCase()
            : '';
          const userId = rawUserId.length > 0 && rawUserId.length <= ${MAX_CHATGPT_ACCOUNT_ID_LENGTH}
            ? rawUserId
            : '';
          const email = rawEmail.length <= ${MAX_CHATGPT_ACCOUNT_EMAIL_LENGTH} && ${CHATGPT_EMAIL_PATTERN}.test(rawEmail)
            ? rawEmail
            : '';
          if (!userId || !email || !globalThis.crypto?.subtle) return null;
          const bytes = new Uint8Array(await crypto.subtle.digest(
            'SHA-256', new TextEncoder().encode(userId),
          ));
          return {
            accountDigest: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
            email,
          };
        } catch {
          return null;
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
      })())()`,
      awaitPromise: true,
      returnByValue: true,
    }),
    timeoutMs,
    ACCOUNT_IDENTITY_TIMEOUT_ERROR,
  );
  const identity = outcome.result?.value as Partial<ChatGptAccountIdentity> | null | undefined;
  const accountDigest = normalizeChatGptAccountDigest(identity?.accountDigest);
  const email = normalizeChatGptAccountEmail(identity?.email);
  if (!accountDigest || !email) {
    throw new Error("Authenticated ChatGPT account identity and email are unavailable.");
  }
  return { accountDigest, email };
}

export async function assertChatGptAccountEmail(
  Runtime: ChromeClient["Runtime"],
  expectedEmail: string,
  action: string,
  remainingMs?: number,
): Promise<string> {
  const normalizedEmail = normalizeChatGptAccountEmail(expectedEmail);
  if (!normalizedEmail) {
    throw new Error("Expected ChatGPT account email is unavailable or invalid.");
  }
  const observed = await readChatGptAccountIdentity(Runtime, remainingMs);
  if (observed.email !== normalizedEmail) {
    throw new Error(`Authenticated ChatGPT email changed before ${action}.`);
  }
  return observed.accountDigest;
}

export async function assertChatGptAccountAffinity(
  Runtime: ChromeClient["Runtime"],
  expectedAccountDigest: string,
  expectedEmail: string,
  action: string,
  remainingMs?: number,
): Promise<string> {
  const normalizedDigest = normalizeChatGptAccountDigest(expectedAccountDigest);
  const normalizedEmail = normalizeChatGptAccountEmail(expectedEmail);
  if (!normalizedDigest || !normalizedEmail) {
    throw new Error("Expected ChatGPT account affinity is incomplete or invalid.");
  }
  const observed = await readChatGptAccountIdentity(Runtime, remainingMs);
  if (observed.accountDigest !== normalizedDigest) {
    throw new Error(`Remote Chrome account identity changed before ${action}.`);
  }
  if (observed.email !== normalizedEmail) {
    throw new Error(`Authenticated ChatGPT email changed before ${action}.`);
  }
  return observed.accountDigest;
}
