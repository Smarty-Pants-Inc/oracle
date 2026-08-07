import { utimes } from "node:fs/promises";
import type {
  FilesystemLockProcessIdentityProvider,
  ProcessLiveness,
} from "../../src/browser/filesystemLock.js";

export async function agePath(targetPath: string, ageMs = 10_000): Promise<void> {
  const timestamp = new Date(Date.now() - ageMs);
  await utimes(targetPath, timestamp, timestamp);
}

export function createProcessIdentityProvider(
  pid: number,
  readProcessStartIdentity: (pid: number) => Promise<string | null>,
  readProcessLiveness: (pid: number) => ProcessLiveness = () => "alive",
  platform: NodeJS.Platform = "linux",
): FilesystemLockProcessIdentityProvider {
  return { platform, pid, readProcessLiveness, readProcessStartIdentity };
}

export function createTestProcessIdentityProvider(
  pid = process.pid,
): FilesystemLockProcessIdentityProvider {
  return {
    platform: process.platform,
    pid,
    readProcessLiveness: (candidatePid) => {
      try {
        process.kill(candidatePid, 0);
        return "alive";
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
      }
    },
    readProcessStartIdentity: async (candidatePid) => `test-process:${candidatePid}`,
  };
}

export const testProcessIdentityProvider = createTestProcessIdentityProvider();
