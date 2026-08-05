import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import {
  assertProfileDirectoryIdentity,
  captureProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
  type ProfileStateLogger,
} from "./profileDirectoryAuthority.js";

const DEVTOOLS_ACTIVE_PORT_FILENAME = "DevToolsActivePort";
const DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS = [
  DEVTOOLS_ACTIVE_PORT_FILENAME,
  path.join("Default", DEVTOOLS_ACTIVE_PORT_FILENAME),
] as const;
export function getDevToolsActivePortPaths(userDataDir: string): string[] {
  return DEVTOOLS_ACTIVE_PORT_RELATIVE_PATHS.map((relative) => path.join(userDataDir, relative));
}

export async function readDevToolsPort(userDataDir: string): Promise<number | null> {
  let profile: ProfileDirectoryIdentity;
  try {
    profile = await captureProfileDirectoryIdentity(userDataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  for (const candidate of getDevToolsActivePortPaths(profile.canonicalPath)) {
    try {
      const before = await lstat(candidate);
      if (before.isSymbolicLink() || !before.isFile()) {
        throw new Error(`Unsafe DevToolsActivePort entry: ${candidate}`);
      }
      const raw = await readFile(candidate, "utf8");
      await assertProfileDirectoryIdentity(userDataDir, profile, "DevTools authority read");
      const after = await lstat(candidate);
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new Error(`DevToolsActivePort changed while reading: ${candidate}`);
      }
      const firstLine = raw.split(/\r?\n/u)[0]?.trim() ?? "";
      if (!/^\d+$/u.test(firstLine)) continue;
      const port = Number.parseInt(firstLine, 10);
      if (port > 0 && port <= 65_535) return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await assertProfileDirectoryIdentity(userDataDir, profile, "DevTools authority read");
    }
  }
  await assertProfileDirectoryIdentity(userDataDir, profile, "DevTools authority read");
  return null;
}
export async function verifyDevToolsReachable({
  port,
  host = "127.0.0.1",
  attempts = 3,
  timeoutMs = 3000,
}: {
  port: number;
  host?: string;
  attempts?: number;
  timeoutMs?: number;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const versionUrl = `http://${host}:${port}/json/version`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetch(versionUrl, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return { ok: true };
    } catch (error) {
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }
  return { ok: false, error: "unreachable" };
}

export async function shouldCleanupManualLoginProfileState(
  userDataDir: string,
  logger?: ProfileStateLogger,
  options: {
    connectionClosedUnexpectedly?: boolean;
    host?: string;
    probe?: typeof verifyDevToolsReachable;
  } = {},
): Promise<boolean> {
  const port = await readDevToolsPort(userDataDir);
  if (!port) {
    return true;
  }
  const probe = await (options.probe ?? verifyDevToolsReachable)({ port, host: options.host });
  if (probe.ok) {
    logger?.(`DevTools port ${port} still reachable; preserving manual-login profile state`);
    return false;
  }
  logger?.(`DevTools port ${port} unreachable (${probe.error}); clearing stale profile state`);
  return true;
}
