import path from "node:path";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import type { BrowserLogger } from "./types.js";
import { delay } from "./utils.js";
import {
  acquireCrashRecoverableFilesystemLock,
  type CrashRecoverableFilesystemLock,
  FilesystemLockBusyError,
  type ProcessLiveness,
  readProcessLiveness,
  readProcessStartIdentity,
} from "./filesystemLock.js";
import {
  captureProfileDirectoryIdentity,
  verifyProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
} from "./profileState.js";

export const DEFAULT_MAX_CONCURRENT_CHATGPT_TABS = 3;
const REGISTRY_FILENAME = "oracle-tab-leases.json";
const REGISTRY_LOCK_DIRNAME = "oracle-tab-leases.lock";
const DEFAULT_POLL_MS = 1000;
const REGISTRY_LOCK_TIMEOUT_MS = 10_000;
const WINDOWS_REGISTRY_MUTATION_RETRY_MS = 10;
const WINDOWS_REGISTRY_MUTATION_TIMEOUT_MS = 1_000;

export interface BrowserTabLeaseRecord {
  id: string;
  pid: number;
  processStartIdentity: string;
  sessionId?: string;
  chromeHost?: string;
  chromePort?: number;
  chromeTargetId?: string;
  tabUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserTabLease {
  id: string;
  readonly profileDirectory: ProfileDirectoryIdentity;
  release: (options?: {
    onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
  }) => Promise<void>;
  update: (patch: Partial<BrowserTabLeaseRecord>) => Promise<void>;
}

interface BrowserTabLeaseRegistryFile {
  version: 1;
  leases: BrowserTabLeaseRecord[];
}

export interface BrowserLeaseLivenessDeps {
  readProcessLiveness?: (pid: number) => ProcessLiveness;
  readProcessStartIdentity?: (pid: number) => Promise<string | null>;
}

interface BrowserTabLeaseDeps extends BrowserLeaseLivenessDeps {
  now?: () => number;
  pid?: number;
}
interface BrowserTabLeaseAuthority {
  readonly requestedPath: string;
  readonly profileDirectory: ProfileDirectoryIdentity;
}

type BrowserTabLeaseAuthorityOptions = {
  expectedProfileIdentity?: ProfileDirectoryIdentity;
};

export type BrowserLeaseTeardownOutcome =
  | { status: "completed" }
  | {
      status: "preserved";
      reason: "active-leases" | "registry-unavailable" | "teardown-unsafe";
      error?: string;
    };

export function normalizeMaxConcurrentTabs(value: unknown): number {
  if (value === undefined || value === null) {
    return DEFAULT_MAX_CONCURRENT_CHATGPT_TABS;
  }
  const numeric = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_MAX_CONCURRENT_CHATGPT_TABS;
  }
  return Math.max(1, Math.trunc(numeric));
}

export async function acquireBrowserTabLease(
  profileDir: string,
  options: {
    maxConcurrentTabs?: number;
    timeoutMs?: number;
    pollMs?: number;
    logger?: BrowserLogger;
    sessionId?: string;
    chromeHost?: string;
    chromePort?: number;
  },
  deps: BrowserTabLeaseDeps = {},
): Promise<BrowserTabLease> {
  const maxConcurrentTabs = normalizeMaxConcurrentTabs(options.maxConcurrentTabs);
  const pollMs = Math.max(50, options.pollMs ?? DEFAULT_POLL_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  const leaseProcessStartIdentity = await (
    deps.readProcessStartIdentity ?? readProcessStartIdentity
  )(pid);
  if (!leaseProcessStartIdentity) {
    throw new Error(
      `Cannot acquire crash-recoverable browser tab lease without a stable process generation for pid ${pid}`,
    );
  }
  const authority = await captureTabLeaseAuthority(profileDir, { create: true });
  const leaseId = randomUUID();
  const startedAt = now();
  let warned = false;
  let lastHeartbeatAt = 0;

  for (;;) {
    const acquired = await withRegistryLock(authority, async () => {
      const registry = await readRegistryForAcquire(authority);
      const active = await pruneStaleLeases(registry.leases, deps);
      if (active.length >= maxConcurrentTabs) {
        if (active.length !== registry.leases.length) {
          await writeRegistry(authority, { version: 1, leases: active });
        }
        return null;
      }
      const timestamp = new Date(now()).toISOString();
      const lease: BrowserTabLeaseRecord = {
        id: leaseId,
        pid,
        processStartIdentity: leaseProcessStartIdentity,
        sessionId: options.sessionId,
        chromeHost: options.chromeHost,
        chromePort: options.chromePort,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await writeRegistry(authority, { version: 1, leases: [...active, lease] });
      return lease;
    });

    if (acquired) {
      options.logger?.(
        `[browser] Acquired ChatGPT browser slot ${leaseId.slice(0, 8)} (${maxConcurrentTabs} max).`,
      );
      return {
        id: leaseId,
        profileDirectory: authority.profileDirectory,
        release: async (releaseOptions) =>
          releaseBrowserTabLeaseWithAuthority(authority, leaseId, options.logger, releaseOptions),
        update: async (patch) => updateBrowserTabLeaseWithAuthority(authority, leaseId, patch),
      };
    }

    const elapsed = now() - startedAt;
    if (!warned || now() - lastHeartbeatAt >= 30_000) {
      options.logger?.(
        `[browser] Waiting for ChatGPT browser slot (${maxConcurrentTabs} max, ${Math.round(elapsed / 1000)}s elapsed).`,
      );
      warned = true;
      lastHeartbeatAt = now();
    }
    if (timeoutMs > 0 && elapsed >= timeoutMs) {
      throw new Error(
        `Timed out waiting for ChatGPT browser slot after ${Math.round(elapsed / 1000)}s (${maxConcurrentTabs} max).`,
      );
    }
    await delay(timeoutMs > 0 ? Math.min(pollMs, timeoutMs - elapsed) : pollMs);
  }
}

export async function updateBrowserTabLease(
  profileDir: string,
  leaseId: string,
  patch: Partial<BrowserTabLeaseRecord>,
): Promise<void> {
  const authority = await captureTabLeaseAuthority(profileDir);
  await updateBrowserTabLeaseWithAuthority(authority, leaseId, patch);
}

async function updateBrowserTabLeaseWithAuthority(
  authority: BrowserTabLeaseAuthority,
  leaseId: string,
  patch: Partial<BrowserTabLeaseRecord>,
): Promise<void> {
  await withRegistryLock(authority, async () => {
    const registry = await readRegistryStrict(authority);
    const leases = registry.leases.map((lease) => {
      if (lease.id !== leaseId) return lease;
      const updated = {
        ...lease,
        ...patch,
        id: lease.id,
        pid: lease.pid,
        processStartIdentity: lease.processStartIdentity,
        createdAt: lease.createdAt,
        updatedAt: new Date().toISOString(),
      };
      if (!isLeaseRecord(updated)) throw new Error("Invalid browser tab lease update");
      return updated;
    });
    await writeRegistry(authority, { version: 1, leases });
  });
}

export async function releaseBrowserTabLease(
  profileDir: string,
  leaseId: string,
  logger?: BrowserLogger,
  options: {
    onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
    expectedProfileIdentity?: ProfileDirectoryIdentity;
  } = {},
): Promise<void> {
  const authority = await captureTabLeaseAuthority(profileDir, options);
  await releaseBrowserTabLeaseWithAuthority(authority, leaseId, logger, options);
}

async function releaseBrowserTabLeaseWithAuthority(
  authority: BrowserTabLeaseAuthority,
  leaseId: string,
  logger?: BrowserLogger,
  options: { onRelease?: (context: { isLastLease: boolean }) => Promise<void> } = {},
): Promise<void> {
  const released = await withRegistryLock(authority, async () => {
    const registry = await readRegistryStrict(authority);
    const active = await pruneStaleLeases(registry.leases, {});
    const leaseWasActive = active.some((lease) => lease.id === leaseId);
    const leases = active.filter((lease) => lease.id !== leaseId);
    if (leases.length !== registry.leases.length) {
      await writeRegistry(authority, { version: 1, leases });
    }
    if (!leaseWasActive) return false;
    await assertTabLeaseAuthority(authority, "final browser lease cleanup");
    await options.onRelease?.({ isLastLease: leases.length === 0 });
    return true;
  });
  if (released) logger?.(`[browser] Released ChatGPT browser slot ${leaseId.slice(0, 8)}.`);
}

export async function hasOtherActiveBrowserTabLeases(
  profileDir: string,
  leaseId: string,
  options: BrowserLeaseLivenessDeps & BrowserTabLeaseAuthorityOptions = {},
): Promise<boolean> {
  const authority = await captureTabLeaseAuthority(profileDir, options);
  return withRegistryLock(authority, async () => {
    const registry = await readRegistryStrict(authority);
    const active = await pruneStaleLeases(registry.leases, options);
    if (active.length !== registry.leases.length) {
      await writeRegistry(authority, { version: 1, leases: active });
    }
    return active.some((lease) => lease.id !== leaseId);
  });
}

export async function teardownBrowserResourcesIfNoActiveLeases(
  profileDir: string,
  teardown: () => Promise<boolean>,
  options: BrowserLeaseLivenessDeps &
    BrowserTabLeaseAuthorityOptions & { logger?: BrowserLogger } = {},
): Promise<BrowserLeaseTeardownOutcome> {
  try {
    const authority = await captureTabLeaseAuthority(profileDir, options);
    return await withRegistryLock(authority, async () => {
      const registry = await readRegistryStrict(authority);
      const active = await pruneStaleLeases(registry.leases, options);
      if (active.length !== registry.leases.length) {
        await writeRegistry(authority, { version: 1, leases: active });
      }
      if (active.length > 0) {
        return { status: "preserved", reason: "active-leases" };
      }
      await assertTabLeaseAuthority(authority, "lease-authorized browser teardown");
      const completed = await teardown();
      return completed
        ? { status: "completed" }
        : { status: "preserved", reason: "teardown-unsafe" };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger?.(
      `[browser] Lease registry unavailable during teardown; preserving Chrome resources: ${message}`,
    );
    return { status: "preserved", reason: "registry-unavailable", error: message };
  }
}

async function captureTabLeaseAuthority(
  profileDir: string,
  options: BrowserTabLeaseAuthorityOptions & { create?: boolean } = {},
): Promise<BrowserTabLeaseAuthority> {
  const profileDirectory =
    options.expectedProfileIdentity ??
    (await captureProfileDirectoryIdentity(profileDir, { create: options.create }));
  const authority = { requestedPath: profileDir, profileDirectory };
  await assertTabLeaseAuthority(authority, "browser tab lease authority capture");
  return authority;
}

async function assertTabLeaseAuthority(
  authority: BrowserTabLeaseAuthority,
  operation: string,
): Promise<void> {
  if (
    !(await verifyProfileDirectoryIdentity(authority.requestedPath, authority.profileDirectory))
  ) {
    throw new Error(
      `${operation} refused because the physical browser profile changed: ${authority.requestedPath}`,
    );
  }
}

async function withRegistryLock<T>(
  authority: BrowserTabLeaseAuthority,
  callback: () => Promise<T>,
): Promise<T> {
  await assertTabLeaseAuthority(authority, "browser tab lease lock acquisition");
  const lockDir = path.join(authority.profileDirectory.canonicalPath, REGISTRY_LOCK_DIRNAME);
  let lock: CrashRecoverableFilesystemLock;
  try {
    lock = await acquireCrashRecoverableFilesystemLock(lockDir, {
      timeoutMs: REGISTRY_LOCK_TIMEOUT_MS,
      pollMs: 50,
      createParent: false,
    });
  } catch (error) {
    if (error instanceof FilesystemLockBusyError) {
      throw new Error(`Timed out waiting for browser tab lease registry lock at ${lockDir}`);
    }
    throw error;
  }
  try {
    await assertTabLeaseAuthority(authority, "browser tab lease lock ownership");
    return await callback();
  } finally {
    await assertTabLeaseAuthority(authority, "browser tab lease lock release");
    await lock.release();
  }
}

async function readRegistryForAcquire(
  authority: BrowserTabLeaseAuthority,
): Promise<BrowserTabLeaseRegistryFile> {
  try {
    return await readRegistryStrict(authority);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      await assertTabLeaseAuthority(authority, "browser tab lease registry initialization");
      return { version: 1, leases: [] };
    }
    throw error;
  }
}

async function readRegistryStrict(
  authority: BrowserTabLeaseAuthority,
): Promise<BrowserTabLeaseRegistryFile> {
  await assertTabLeaseAuthority(authority, "browser tab lease registry read");
  const raw = await readFile(registryPath(authority), "utf8");
  await assertTabLeaseAuthority(authority, "browser tab lease registry read");
  const parsed = JSON.parse(raw) as BrowserTabLeaseRegistryFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.leases)) {
    throw new Error("Invalid browser tab lease registry");
  }
  const leases = parsed.leases.filter(isLeaseRecord);
  if (leases.length !== parsed.leases.length) {
    throw new Error("Invalid browser tab lease record");
  }
  return { version: 1, leases };
}

async function writeRegistry(
  authority: BrowserTabLeaseAuthority,
  registry: BrowserTabLeaseRegistryFile,
): Promise<void> {
  await assertTabLeaseAuthority(authority, "browser tab lease registry persistence");
  const profileDir = authority.profileDirectory.canonicalPath;
  const targetPath = registryPath(authority);
  const tempPath = path.join(
    profileDir,
    `.${REGISTRY_FILENAME}.tmp-${process.pid}-${randomUUID()}`,
  );
  try {
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertTabLeaseAuthority(authority, "browser tab lease registry persistence");
    await replaceRegistryFile(tempPath, targetPath);
    await syncDirectory(profileDir);
    await assertTabLeaseAuthority(authority, "browser tab lease registry persistence");
  } finally {
    if (await verifyProfileDirectoryIdentity(authority.requestedPath, authority.profileDirectory)) {
      await rm(tempPath, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: WINDOWS_REGISTRY_MUTATION_RETRY_MS,
      }).catch(() => undefined);
      await syncDirectory(profileDir);
    }
  }
}

function registryPath(authority: BrowserTabLeaseAuthority): string {
  return path.join(authority.profileDirectory.canonicalPath, REGISTRY_FILENAME);
}

async function pruneStaleLeases(
  leases: BrowserTabLeaseRecord[],
  deps: BrowserLeaseLivenessDeps,
): Promise<BrowserTabLeaseRecord[]> {
  const readLiveness = deps.readProcessLiveness ?? readProcessLiveness;
  const readStartIdentity = deps.readProcessStartIdentity ?? readProcessStartIdentity;
  const observedProcessIdentities = new Map<number, Promise<string | null>>();
  const active: BrowserTabLeaseRecord[] = [];
  for (const lease of leases) {
    const liveness = readLiveness(lease.pid);
    if (liveness === "dead") continue;
    if (liveness === "alive") {
      let observedIdentityPromise = observedProcessIdentities.get(lease.pid);
      if (!observedIdentityPromise) {
        observedIdentityPromise = readStartIdentity(lease.pid);
        observedProcessIdentities.set(lease.pid, observedIdentityPromise);
      }
      const observedIdentity = await observedIdentityPromise;
      if (observedIdentity !== null && observedIdentity !== lease.processStartIdentity) continue;
    }
    active.push(lease);
  }
  return active;
}

function isLeaseRecord(value: unknown): value is BrowserTabLeaseRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as BrowserTabLeaseRecord;
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    Number.isInteger(record.pid) &&
    typeof record.processStartIdentity === "string" &&
    record.processStartIdentity.length > 0 &&
    record.pid > 0 &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    typeof record.updatedAt === "string" &&
    Number.isFinite(Date.parse(record.updatedAt)) &&
    isOptionalString(record.sessionId) &&
    isOptionalString(record.chromeHost) &&
    (record.chromePort === undefined ||
      (Number.isInteger(record.chromePort) && record.chromePort > 0)) &&
    isOptionalString(record.chromeTargetId) &&
    isOptionalString(record.tabUrl)
  );
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

async function replaceRegistryFile(sourcePath: string, destinationPath: string): Promise<void> {
  const deadline = Date.now() + WINDOWS_REGISTRY_MUTATION_TIMEOUT_MS;
  for (;;) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      const code = readErrorCode(error);
      const retryable =
        process.platform === "win32" && (code === "EACCES" || code === "EBUSY" || code === "EPERM");
      if (!retryable || Date.now() >= deadline) throw error;
    }
    await delay(Math.min(WINDOWS_REGISTRY_MUTATION_RETRY_MS, Math.max(1, deadline - Date.now())));
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function readErrorCode(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}
