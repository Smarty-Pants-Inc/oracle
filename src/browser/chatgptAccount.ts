import type { ChromeClient } from "./types.js";

export interface ChatGptAccountIdentity {
  accountDigest: string;
  email: string;
}

/** Reads only the authenticated user id digest and normalized email from ChatGPT's page context. */
export async function readChatGptAccountIdentity(
  Runtime: ChromeClient["Runtime"],
): Promise<ChatGptAccountIdentity> {
  const outcome = await Runtime.evaluate({
    expression: `(() => (async () => {
      try {
        const response = await fetch('/api/auth/session', {
          method: 'GET', cache: 'no-store', credentials: 'include',
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
      }
    })())()`,
    awaitPromise: true,
    returnByValue: true,
  });
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
): Promise<string> {
  const normalizedEmail = expectedEmail.trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error("Expected ChatGPT account email is unavailable.");
  }
  const observed = await readChatGptAccountIdentity(Runtime);
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
): Promise<string> {
  const normalizedEmail = expectedEmail.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedAccountDigest) || !normalizedEmail) {
    throw new Error("Expected ChatGPT account affinity is incomplete or invalid.");
  }
  const observed = await readChatGptAccountIdentity(Runtime);
  if (observed.accountDigest !== expectedAccountDigest) {
    throw new Error(`Remote Chrome account identity changed before ${action}.`);
  }
  if (observed.email !== normalizedEmail) {
    throw new Error(`Authenticated ChatGPT email changed before ${action}.`);
  }
  return observed.accountDigest;
}
