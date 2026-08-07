import path from "node:path";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { readErrorCode, syncDirectory } from "../fsDurability.js";
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
import { arePlatformProcessGenerationsDefinitelyDifferent } from "./platformProcessGeneration.js";
import {
  captureProfileDirectoryIdentity,
  verifyProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
} from "./profileState.js";

export const DEFAULT_MAX_CONCURRENT_CHATGPT_TABS = 3;
const REGISTRY_FILENAME = "oracle-tab-leases.json";
const REGISTRY_LOCK_DIRNAME = "oracle-tab-leases.lock";
const CURRENT_REGISTRY_VERSION = 3;
const DEFAULT_POLL_MS = 1000;
const REGISTRY_LOCK_TIMEOUT_MS = 10_000;
const WINDOWS_REGISTRY_MUTATION_RETRY_MS = 10;
const WINDOWS_REGISTRY_MUTATION_TIMEOUT_MS = 1_000;

export interface BrowserTabLeaseRecord {
  id: string;
  pid: number;
  processStartIdentity: string | null;
  sessionId: string;
  generationId: string;
  chromeHost?: string;
  chromePort?: number;
  chromeTargetId?: string;
  tabUrl?: string;
  createdAt: string;
  updatedAt: string;
}
export interface BrowserTabLeaseReleaseOptions {
  onRelease?: (context: { isLastLease: boolean }) => Promise<void>;
}

export interface BrowserTabLeaseIdentity {
  readonly id: string;
  readonly sessionId: string;
  readonly generationId: string;
  readonly profileDirectory: ProfileDirectoryIdentity;
}

export interface BrowserTabLease extends BrowserTabLeaseIdentity {
  release: (options?: BrowserTabLeaseReleaseOptions) => Promise<void>;
  update: (patch: Partial<BrowserTabLeaseRecord>) => Promise<void>;
}

function snapshotBrowserTabLeaseIdentity(lease: BrowserTabLeaseIdentity): BrowserTabLeaseIdentity {
  const id = lease.id.trim();
  const sessionId = lease.sessionId.trim();
  const generationId = lease.generationId.trim();
  if (!id || !sessionId || !generationId) {
    throw new Error(
      "Browser tab lease authority requires an id, owner, and acquisition generation.",
    );
  }
  return Object.freeze({
    id,
    sessionId,
    generationId,
    profileDirectory: Object.freeze({ ...lease.profileDirectory }),
  });
}

/** The exact-base v1 record shape, which had no process or acquisition generation. */
interface LegacyBrowserTabLeaseRecord extends Omit<
  BrowserTabLeaseRecord,
  "processStartIdentity" | "generationId" | "sessionId"
> {
  processStartIdentity?: never;
  generationId?: never;
  sessionId?: string;
}

/** The exact-base v2 record shape, which had no acquisition generation. */
interface GenerationlessBrowserTabLeaseRecord extends Omit<
  BrowserTabLeaseRecord,
  "generationId" | "sessionId"
> {
  generationId?: never;
  sessionId?: string;
}

type BrowserTabLeaseRegistryRecord =
  | BrowserTabLeaseRecord
  | GenerationlessBrowserTabLeaseRecord
  | LegacyBrowserTabLeaseRecord;

interface BrowserTabLeaseRegistryFile {
  version: typeof CURRENT_REGISTRY_VERSION;
  leases: BrowserTabLeaseRegistryRecord[];
}

interface LegacyBrowserTabLeaseRegistryFile {
  version: 1 | 2;
  leases: BrowserTabLeaseRegistryRecord[];
}

interface BrowserTabLeaseRegistryRead {
  registry: BrowserTabLeaseRegistryFile;
  requiresMigration: boolean;
}

export interface BrowserLeaseLivenessDeps {
  readProcessLiveness?: (pid: number) => ProcessLiveness;
  readProcessStartIdentity?: (pid: number) => Promise<string | null>;
}

interface BrowserTabLeaseDeps extends BrowserLeaseLivenessDeps {
  now?: () => number;
  pid?: number;
  // Test seam for the Windows-only null-generation exception; production callers omit it.
  platform?: NodeJS.Platform;
  // Test seam for a delayed registry admission; production callers omit it.
  beforeRegistryLockAcquisition?: () => Promise<void>;
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
export type BrowserTabLeaseTeardownSettlement =
  | {
      status: "completed";
      disposition: "teardown-completed" | "active-lease-handoff";
    }
  | {
      status: "preserved";
      reason: "active-leases" | "registry-unavailable" | "teardown-unsafe";
      error?: string;
    };

export interface BrowserTabLeaseTeardownAuthority {
  readonly leaseReleased: boolean;
  settle: (teardown: () => Promise<boolean>) => Promise<BrowserTabLeaseTeardownSettlement>;
}

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
    sessionId: string;
    generationId: string;
    chromeHost?: string;
    chromePort?: number;
    leaseId?: string;
  },
  deps: BrowserTabLeaseDeps = {},
): Promise<BrowserTabLease> {
  const maxConcurrentTabs = normalizeMaxConcurrentTabs(options.maxConcurrentTabs);
  const pollMs = Math.max(50, options.pollMs ?? DEFAULT_POLL_MS);
  const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
  const now = deps.now ?? Date.now;
  const sessionId = options.sessionId.trim();
  const generationId = options.generationId.trim();
  if (!sessionId || !generationId) {
    throw new Error("Browser tab lease acquisition requires a trusted owner and generation.");
  }
  const pid = deps.pid ?? process.pid;
  const leaseProcessStartIdentity = await (
    deps.readProcessStartIdentity ?? readProcessStartIdentity
  )(pid);
  // A timed-out Windows probe for the real current process must not block manual login. The null
  // generation stays active while liveness cannot prove that PID dead; injected and foreign PIDs
  // must retain a verified generation to prevent unsafe reclamation.
  const permitsUnverifiedCurrentProcess =
    (deps.platform ?? process.platform) === "win32" &&
    pid === process.pid &&
    deps.readProcessStartIdentity === undefined;
  if (
    !leaseProcessStartIdentity &&
    !(leaseProcessStartIdentity === null && permitsUnverifiedCurrentProcess)
  ) {
    throw new Error(
      `Cannot acquire crash-recoverable browser tab lease without a stable process generation for pid ${pid}`,
    );
  }
  const authority = await captureTabLeaseAuthority(profileDir, { create: true });
  const leaseId = (options.leaseId ?? randomUUID()).trim();
  if (!leaseId) throw new Error("Browser tab lease acquisition requires a lease id.");
  const leaseIdentity = snapshotBrowserTabLeaseIdentity({
    id: leaseId,
    sessionId,
    generationId,
    profileDirectory: authority.profileDirectory,
  });
  // Release must judge this record with the same process-generation observer that admitted it.
  const leaseLivenessDeps: BrowserLeaseLivenessDeps = {
    ...(deps.readProcessLiveness ? { readProcessLiveness: deps.readProcessLiveness } : {}),
    ...(deps.readProcessStartIdentity
      ? { readProcessStartIdentity: deps.readProcessStartIdentity }
      : {}),
  };
  let waitingSince: number | undefined;
  let warned = false;
  let lastHeartbeatAt = 0;

  for (;;) {
    await deps.beforeRegistryLockAcquisition?.();
    const acquired = await withRegistryLock(authority, async () => {
      const { registry, requiresMigration } = await readRegistryForAcquire(authority);
      const active = await pruneStaleLeases(registry.leases, deps);
      if (active.some((lease) => lease.id === leaseId)) {
        throw new Error(`Browser tab lease id is already active: ${leaseId}`);
      }
      if (active.length >= maxConcurrentTabs) {
        if (requiresMigration || active.length !== registry.leases.length) {
          await writeRegistry(authority, { version: CURRENT_REGISTRY_VERSION, leases: active });
        }
        return null;
      }
      const timestamp = new Date(now()).toISOString();
      const lease: BrowserTabLeaseRecord = {
        id: leaseId,
        pid,
        processStartIdentity: leaseProcessStartIdentity,
        sessionId,
        generationId,
        chromeHost: options.chromeHost,
        chromePort: options.chromePort,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await writeRegistry(authority, {
        version: CURRENT_REGISTRY_VERSION,
        leases: [...active, lease],
      });
      return lease;
    });

    if (acquired) {
      options.logger?.(
        `[browser] Acquired ChatGPT browser slot ${leaseId.slice(0, 8)} (${maxConcurrentTabs} max).`,
      );
      return Object.freeze({
        ...leaseIdentity,
        release: async (releaseOptions?: BrowserTabLeaseReleaseOptions) =>
          releaseBrowserTabLeaseWithAuthority(
            authority,
            leaseIdentity,
            options.logger,
            releaseOptions,
            leaseLivenessDeps,
          ),
        update: async (patch: Partial<BrowserTabLeaseRecord>) =>
          updateBrowserTabLeaseWithAuthority(authority, leaseIdentity, patch),
      });
    }

    const queuedAt = waitingSince ?? (waitingSince = now());
    const elapsed = now() - queuedAt;
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
function matchesBrowserTabLeaseIdentity(
  record: BrowserTabLeaseRegistryRecord,
  identity: BrowserTabLeaseIdentity,
): record is BrowserTabLeaseRecord {
  return (
    isLeaseRecord(record) &&
    record.id === identity.id &&
    record.sessionId === identity.sessionId &&
    record.generationId === identity.generationId
  );
}

export function retainBrowserTabLeaseTeardownAuthority(
  profileDir: string,
  lease: BrowserTabLeaseIdentity,
  options: BrowserLeaseLivenessDeps & {
    logger?: BrowserLogger;
    onActiveLeaseHandoff?: () => Promise<void>;
  } = {},
): BrowserTabLeaseTeardownAuthority {
  const leaseIdentity = snapshotBrowserTabLeaseIdentity(lease);
  const authority: BrowserTabLeaseAuthority = {
    requestedPath: profileDir,
    profileDirectory: leaseIdentity.profileDirectory,
  };
  type Phase =
    | "leased"
    | "released"
    | "teardown-completed"
    | "handoff-pending-confirmation"
    | "completed"
    | "handed-off";
  let phase: Phase = "leased";

  const unavailable = (error: unknown): BrowserTabLeaseTeardownSettlement => {
    const message = error instanceof Error ? error.message : String(error);
    options.logger?.(
      `[browser] Lease registry unavailable during teardown; preserving Chrome resources: ${message}`,
    );
    return { status: "preserved", reason: "registry-unavailable", error: message };
  };

  return {
    get leaseReleased() {
      return phase !== "leased";
    },
    settle: async (teardown) => {
      if (phase === "completed") {
        return { status: "completed", disposition: "teardown-completed" };
      }
      if (phase === "handed-off") {
        return { status: "completed", disposition: "active-lease-handoff" };
      }

      try {
        const result = await withRegistryLock(authority, async () => {
          const { registry, requiresMigration } = await readRegistryStrict(authority);
          if (
            registry.leases.some(
              (entry) =>
                entry.id === leaseIdentity.id &&
                !matchesBrowserTabLeaseIdentity(entry, leaseIdentity),
            )
          ) {
            throw new Error("Browser tab lease owner or acquisition generation does not match.");
          }
          const active = await pruneStaleLeases(registry.leases, options);
          if (requiresMigration || active.length !== registry.leases.length) {
            await writeRegistry(authority, { version: CURRENT_REGISTRY_VERSION, leases: active });
          }

          if (phase === "teardown-completed") {
            return { status: "completed", disposition: "teardown-completed" } as const;
          }
          if (phase === "handoff-pending-confirmation") {
            if (active.length > 0) {
              try {
                await options.onActiveLeaseHandoff?.();
                return { status: "completed", disposition: "active-lease-handoff" } as const;
              } catch (error) {
                return {
                  status: "preserved",
                  reason: "teardown-unsafe",
                  error: error instanceof Error ? error.message : String(error),
                } as const;
              }
            }
            phase = "released";
          }

          const activeLease = active.find((entry) => entry.id === leaseIdentity.id);
          const leaseWasActive = Boolean(activeLease);
          const remaining = active.filter(
            (entry) => !matchesBrowserTabLeaseIdentity(entry, leaseIdentity),
          );
          if (phase === "leased") {
            if (leaseWasActive) {
              await writeRegistry(authority, {
                version: CURRENT_REGISTRY_VERSION,
                leases: remaining,
              });
            }
            phase = "released";
            if (leaseWasActive && remaining.length > 0) {
              phase = "handoff-pending-confirmation";
              try {
                await options.onActiveLeaseHandoff?.();
                return { status: "completed", disposition: "active-lease-handoff" } as const;
              } catch (error) {
                return {
                  status: "preserved",
                  reason: "teardown-unsafe",
                  error: error instanceof Error ? error.message : String(error),
                } as const;
              }
            }
          }

          if (remaining.length > 0) {
            return { status: "preserved", reason: "active-leases" } as const;
          }

          await assertTabLeaseAuthority(authority, "lease-authorized browser teardown");
          try {
            if (!(await teardown())) {
              return { status: "preserved", reason: "teardown-unsafe" } as const;
            }
          } catch (error) {
            return {
              status: "preserved",
              reason: "teardown-unsafe",
              error: error instanceof Error ? error.message : String(error),
            } as const;
          }
          phase = "teardown-completed";
          return { status: "completed", disposition: "teardown-completed" } as const;
        });

        if (result.status === "completed") {
          phase = result.disposition === "teardown-completed" ? "completed" : "handed-off";
        }
        return result;
      } catch (error) {
        return unavailable(error);
      }
    },
  };
}

export async function hasExactBrowserTabLease(
  profileDir: string,
  lease: BrowserTabLeaseIdentity,
): Promise<boolean> {
  const leaseIdentity = snapshotBrowserTabLeaseIdentity(lease);
  const authority = await captureTabLeaseAuthority(profileDir, {
    expectedProfileIdentity: leaseIdentity.profileDirectory,
  });
  return withRegistryLock(authority, async () => {
    const { registry } = await readRegistryStrict(authority);
    const activeLease = registry.leases.find((entry) => entry.id === leaseIdentity.id);
    if (!activeLease) return false;
    if (!matchesBrowserTabLeaseIdentity(activeLease, leaseIdentity)) {
      throw new Error("Browser tab lease owner or acquisition generation does not match.");
    }
    return true;
  });
}

export async function updateBrowserTabLease(
  profileDir: string,
  lease: BrowserTabLeaseIdentity,
  patch: Partial<BrowserTabLeaseRecord>,
): Promise<void> {
  const leaseIdentity = snapshotBrowserTabLeaseIdentity(lease);
  const authority = await captureTabLeaseAuthority(profileDir, {
    expectedProfileIdentity: leaseIdentity.profileDirectory,
  });
  await updateBrowserTabLeaseWithAuthority(authority, leaseIdentity, patch);
}

async function updateBrowserTabLeaseWithAuthority(
  authority: BrowserTabLeaseAuthority,
  leaseIdentity: BrowserTabLeaseIdentity,
  patch: Partial<BrowserTabLeaseRecord>,
): Promise<void> {
  await withRegistryLock(authority, async () => {
    const { registry } = await readRegistryStrict(authority);
    let updatedLease = false;
    const leases = registry.leases.map((lease) => {
      if (lease.id !== leaseIdentity.id) return lease;
      if (!matchesBrowserTabLeaseIdentity(lease, leaseIdentity)) {
        throw new Error("Browser tab lease owner or acquisition generation does not match.");
      }
      updatedLease = true;
      const updated = {
        ...lease,
        ...patch,
        id: lease.id,
        pid: lease.pid,
        processStartIdentity: lease.processStartIdentity,
        sessionId: lease.sessionId,
        generationId: lease.generationId,
        createdAt: lease.createdAt,
        updatedAt: new Date().toISOString(),
      };
      if (!isLeaseRecord(updated)) throw new Error("Invalid browser tab lease update");
      return updated;
    });
    if (!updatedLease) throw new Error("Browser tab lease is no longer active.");
    await writeRegistry(authority, { version: CURRENT_REGISTRY_VERSION, leases });
  });
}

export async function releaseBrowserTabLease(
  profileDir: string,
  lease: BrowserTabLeaseIdentity,
  logger?: BrowserLogger,
  options: BrowserTabLeaseReleaseOptions = {},
): Promise<void> {
  const leaseIdentity = snapshotBrowserTabLeaseIdentity(lease);
  const authority = await captureTabLeaseAuthority(profileDir, {
    expectedProfileIdentity: leaseIdentity.profileDirectory,
  });
  await releaseBrowserTabLeaseWithAuthority(authority, leaseIdentity, logger, options);
}

async function releaseBrowserTabLeaseWithAuthority(
  authority: BrowserTabLeaseAuthority,
  leaseIdentity: BrowserTabLeaseIdentity,
  logger?: BrowserLogger,
  options: BrowserTabLeaseReleaseOptions = {},
  livenessDeps: BrowserLeaseLivenessDeps = {},
): Promise<void> {
  const released = await withRegistryLock(authority, async () => {
    const { registry, requiresMigration } = await readRegistryStrict(authority);
    if (
      registry.leases.some(
        (lease) =>
          lease.id === leaseIdentity.id && !matchesBrowserTabLeaseIdentity(lease, leaseIdentity),
      )
    ) {
      throw new Error("Browser tab lease owner or acquisition generation does not match.");
    }
    const active = await pruneStaleLeases(registry.leases, livenessDeps);
    const activeLease = active.find((lease) => lease.id === leaseIdentity.id);
    const leaseWasActive = Boolean(activeLease);
    const leases = active.filter((lease) => !matchesBrowserTabLeaseIdentity(lease, leaseIdentity));
    if (requiresMigration || leases.length !== registry.leases.length) {
      await writeRegistry(authority, { version: CURRENT_REGISTRY_VERSION, leases });
    }
    if (!leaseWasActive) return false;
    await assertTabLeaseAuthority(authority, "final browser lease cleanup");
    await options.onRelease?.({ isLastLease: leases.length === 0 });
    return true;
  });
  if (released) {
    logger?.(`[browser] Released ChatGPT browser slot ${leaseIdentity.id.slice(0, 8)}.`);
  }
}

export async function hasOtherActiveBrowserTabLeases(
  profileDir: string,
  lease: BrowserTabLeaseIdentity,
  options: BrowserLeaseLivenessDeps = {},
): Promise<boolean> {
  const leaseIdentity = snapshotBrowserTabLeaseIdentity(lease);
  const authority = await captureTabLeaseAuthority(profileDir, {
    expectedProfileIdentity: leaseIdentity.profileDirectory,
  });
  return withRegistryLock(authority, async () => {
    const { registry, requiresMigration } = await readRegistryStrict(authority);
    if (
      registry.leases.some(
        (entry) =>
          entry.id === leaseIdentity.id && !matchesBrowserTabLeaseIdentity(entry, leaseIdentity),
      )
    ) {
      return true;
    }
    const active = await pruneStaleLeases(registry.leases, options);
    if (requiresMigration || active.length !== registry.leases.length) {
      await writeRegistry(authority, { version: CURRENT_REGISTRY_VERSION, leases: active });
    }
    return active.some((entry) => !matchesBrowserTabLeaseIdentity(entry, leaseIdentity));
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
      const { registry, requiresMigration } = await readRegistryStrict(authority);
      const active = await pruneStaleLeases(registry.leases, options);
      if (requiresMigration || active.length !== registry.leases.length) {
        await writeRegistry(authority, { version: CURRENT_REGISTRY_VERSION, leases: active });
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
      processGenerationPolicy: "allow-unstable-current-win32",
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
): Promise<BrowserTabLeaseRegistryRead> {
  try {
    return await readRegistryStrict(authority);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") {
      await assertTabLeaseAuthority(authority, "browser tab lease registry initialization");
      return {
        registry: { version: CURRENT_REGISTRY_VERSION, leases: [] },
        requiresMigration: false,
      };
    }
    throw error;
  }
}

async function readRegistryStrict(
  authority: BrowserTabLeaseAuthority,
): Promise<BrowserTabLeaseRegistryRead> {
  await assertTabLeaseAuthority(authority, "browser tab lease registry read");
  const raw = await readFile(registryPath(authority), "utf8");
  await assertTabLeaseAuthority(authority, "browser tab lease registry read");
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid browser tab lease registry");
  }
  const candidate = parsed as { version?: unknown; leases?: unknown };
  const version = candidate.version;
  if (
    (version !== 1 && version !== 2 && version !== CURRENT_REGISTRY_VERSION) ||
    !Array.isArray(candidate.leases)
  ) {
    throw new Error("Invalid browser tab lease registry");
  }
  const leases = candidate.leases.filter(isRegistryLeaseRecord);
  if (leases.length !== candidate.leases.length) {
    throw new Error("Invalid browser tab lease record");
  }
  const file: BrowserTabLeaseRegistryFile | LegacyBrowserTabLeaseRegistryFile = {
    version,
    leases,
  };
  return {
    registry: { version: CURRENT_REGISTRY_VERSION, leases: file.leases },
    requiresMigration: file.version !== CURRENT_REGISTRY_VERSION,
  };
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
  leases: BrowserTabLeaseRegistryRecord[],
  deps: BrowserLeaseLivenessDeps,
): Promise<BrowserTabLeaseRegistryRecord[]> {
  const readLiveness = deps.readProcessLiveness ?? readProcessLiveness;
  const readStartIdentity = deps.readProcessStartIdentity ?? readProcessStartIdentity;
  const observedProcessIdentities = new Map<number, Promise<string | null>>();
  const active: BrowserTabLeaseRegistryRecord[] = [];
  for (const lease of leases) {
    const liveness = readLiveness(lease.pid);
    if (liveness === "dead") continue;
    if (
      "processStartIdentity" in lease &&
      typeof lease.processStartIdentity === "string" &&
      liveness === "alive"
    ) {
      let observedIdentityPromise = observedProcessIdentities.get(lease.pid);
      if (!observedIdentityPromise) {
        observedIdentityPromise = readStartIdentity(lease.pid);
        observedProcessIdentities.set(lease.pid, observedIdentityPromise);
      }
      const observedIdentity = await observedIdentityPromise;
      if (
        observedIdentity !== null &&
        arePlatformProcessGenerationsDefinitelyDifferent(
          lease.processStartIdentity,
          observedIdentity,
        )
      ) {
        continue;
      }
    }
    active.push(lease);
  }
  return active;
}

function isRegistryLeaseRecord(value: unknown): value is BrowserTabLeaseRegistryRecord {
  return isLeaseRecord(value) || isGenerationlessLeaseRecord(value) || isLegacyLeaseRecord(value);
}

function isLeaseRecord(value: unknown): value is BrowserTabLeaseRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    hasValidLeaseRecordFields(record) &&
    typeof record.sessionId === "string" &&
    record.sessionId.trim().length > 0 &&
    typeof record.generationId === "string" &&
    record.generationId.trim().length > 0 &&
    (record.processStartIdentity === null ||
      (typeof record.processStartIdentity === "string" && record.processStartIdentity.length > 0))
  );
}

function isGenerationlessLeaseRecord(value: unknown): value is GenerationlessBrowserTabLeaseRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    !Object.hasOwn(record, "generationId") &&
    Object.hasOwn(record, "processStartIdentity") &&
    hasValidLeaseRecordFields(record) &&
    (record.processStartIdentity === null ||
      (typeof record.processStartIdentity === "string" && record.processStartIdentity.length > 0))
  );
}

function isLegacyLeaseRecord(value: unknown): value is LegacyBrowserTabLeaseRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    !Object.hasOwn(record, "processStartIdentity") &&
    !Object.hasOwn(record, "generationId") &&
    hasValidLeaseRecordFields(record)
  );
}

function hasValidLeaseRecordFields(record: Record<string, unknown>): boolean {
  return (
    typeof record.id === "string" &&
    record.id.length > 0 &&
    Number.isInteger(record.pid) &&
    Number(record.pid) > 0 &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    typeof record.updatedAt === "string" &&
    Number.isFinite(Date.parse(record.updatedAt)) &&
    isOptionalString(record.sessionId) &&
    isOptionalString(record.generationId) &&
    isOptionalString(record.chromeHost) &&
    (record.chromePort === undefined ||
      (Number.isInteger(record.chromePort) && Number(record.chromePort) > 0)) &&
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
