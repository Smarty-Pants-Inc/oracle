import type { ChromeClient } from "./types.js";
import { withTimeout } from "./reattachHelpers.js";

export interface ChatGptAccountIdentity {
  accountDigest: string;
  email: string;
}
const DEFAULT_ACCOUNT_IDENTITY_TIMEOUT_MS = 10_000;
const ACCOUNT_IDENTITY_TIMEOUT_ERROR =
  "Timed out while reading authenticated ChatGPT account identity.";

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
        let timeout;
        try {
          const controller = new AbortController();
          timeout = setTimeout(() => controller.abort(), timeoutMs);
          const response = await fetch('/api/auth/session', {
            method: 'GET', cache: 'no-store', credentials: 'include', signal: controller.signal,
          });
          if (!response.ok) return null;
          const body = await response.json();
          const userId = typeof body?.user?.id === 'string' ? body.user.id.trim() : '';
          const email = typeof body?.user?.email === 'string'
            ? body.user.email.trim().toLowerCase()
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
  if (
    !identity ||
    typeof identity.accountDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(identity.accountDigest) ||
    typeof identity.email !== "string" ||
    !identity.email.trim()
  ) {
    throw new Error("Authenticated ChatGPT account identity and email are unavailable.");
  }
  return {
    accountDigest: identity.accountDigest,
    email: identity.email.trim().toLowerCase(),
  };
}

export async function assertChatGptAccountEmail(
  Runtime: ChromeClient["Runtime"],
  expectedEmail: string,
  action: string,
  remainingMs?: number,
): Promise<string> {
  const normalizedEmail = expectedEmail.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("Expected ChatGPT account email is unavailable.");
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
  const normalizedEmail = expectedEmail.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedAccountDigest) || !normalizedEmail) {
    throw new Error("Expected ChatGPT account affinity is incomplete or invalid.");
  }
  const observed = await readChatGptAccountIdentity(Runtime, remainingMs);
  if (observed.accountDigest !== expectedAccountDigest) {
    throw new Error(`Remote Chrome account identity changed before ${action}.`);
  }
  if (observed.email !== normalizedEmail) {
    throw new Error(`Authenticated ChatGPT email changed before ${action}.`);
  }
  return observed.accountDigest;
}
