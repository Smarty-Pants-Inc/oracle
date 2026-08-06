import { randomUUID } from "node:crypto";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export const CHROME_LAUNCH_CLAIM_FLAG = "--oracle-launch-claim";

export function isChromeProcessNonce(value: unknown): value is string {
  return typeof value === "string" && UUID_V4_PATTERN.test(value);
}

export interface ChromeProcessLaunchClaim {
  readonly version: 1;
  readonly generationId: string;
  readonly nonce: string;
}

export function createChromeProcessLaunchClaim(
  generationId = randomUUID(),
): ChromeProcessLaunchClaim {
  const claim = parseChromeProcessLaunchClaim({ version: 1, generationId, nonce: randomUUID() });
  if (!claim) throw new Error("Chrome launch claim generation must be a UUID v4");
  return claim;
}

export function parseChromeProcessLaunchClaim(value: unknown): ChromeProcessLaunchClaim | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !isChromeProcessNonce(record.generationId) ||
    !isChromeProcessNonce(record.nonce)
  ) {
    return null;
  }
  return Object.freeze({ version: 1, generationId: record.generationId, nonce: record.nonce });
}

export function sameChromeProcessLaunchClaim(
  left: ChromeProcessLaunchClaim | undefined,
  right: ChromeProcessLaunchClaim | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.version === right.version &&
    left.generationId === right.generationId &&
    left.nonce === right.nonce
  );
}

export function buildChromeProcessLaunchClaimFlag(claim: ChromeProcessLaunchClaim): string {
  const validated = parseChromeProcessLaunchClaim(claim);
  if (!validated) throw new Error("Chrome launch claim is invalid");
  return `${CHROME_LAUNCH_CLAIM_FLAG}=${validated.generationId}:${validated.nonce}`;
}
