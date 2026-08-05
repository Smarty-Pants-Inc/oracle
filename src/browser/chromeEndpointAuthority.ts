import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import CDP from "chrome-remote-interface";
import type { LaunchedChrome } from "chrome-launcher";
import type { ChromeClient } from "./types.js";
import {
  inspectChromeProcessIdentity,
  isSafeChromeTerminationOutcome,
  writeOracleChromeOwner,
  type ChromeProcessIdentity,
  type ChromeProcessIdentityInspection,
  type OracleChromeOwnerRecord,
  type RecordedChromeTerminationOutcome,
} from "./profileState.js";
import { delay } from "./utils.js";

const execFileAsync = promisify(execFile);

export type ChromeStableKill = () => Promise<RecordedChromeTerminationOutcome>;

export interface StableChromeProcessHandle {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  unref?(): void;
}
export async function createOwnerBoundChromeKill(
  userDataDir: string,
  owner: OracleChromeOwnerRecord,
  stableKill: ChromeStableKill,
  deps: { writeOwner?: typeof writeOracleChromeOwner } = {},
): Promise<ChromeStableKill> {
  try {
    await (deps.writeOwner ?? writeOracleChromeOwner)(userDataDir, owner);
  } catch (error) {
    const rollback = await stableKill();
    if (!isSafeChromeTerminationOutcome(rollback)) {
      throw new AggregateError(
        [error, new Error(rollback.reason)],
        `Failed to persist Chrome owner authority, and safe launch rollback was unavailable.`,
      );
    }
    throw new Error(`Failed to persist Chrome owner authority for ${userDataDir}.`, {
      cause: error,
    });
  }
  return stableKill;
}

export function retainChromeChildProcess(
  child: LaunchedChrome["process"],
): StableChromeProcessHandle {
  return {
    get pid() {
      return child.pid;
    },
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    unref: () => child.unref(),
  };
}

export function createStableChildProcessChromeKill(
  child: StableChromeProcessHandle,
  exactControlKill: ChromeStableKill,
): ChromeStableKill {
  return createTerminalCachingChromeKill(async () => {
    const pid = child.pid;
    if (!pid) {
      return {
        status: "unsafe",
        reason: "Retained Chrome process handle has no stable process id",
      };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return { status: "already-stopped", pid };
    }
    const outcome = await exactControlKill();
    if (isSafeChromeTerminationOutcome(outcome) && outcome.pid !== pid) {
      return {
        status: "unsafe",
        pid,
        reason: "Exact Chrome control channel returned a different process identity",
      };
    }
    return outcome;
  });
}

function createTerminalCachingChromeKill(attemptKill: ChromeStableKill): ChromeStableKill {
  let completed: RecordedChromeTerminationOutcome | undefined;
  let pending: Promise<RecordedChromeTerminationOutcome> | undefined;
  return () => {
    if (completed) return Promise.resolve(completed);
    if (pending) return pending;
    const attempt = Promise.resolve().then(attemptKill);
    pending = attempt;
    void attempt.then(
      (outcome) => {
        if (isSafeChromeTerminationOutcome(outcome)) completed = outcome;
        if (pending === attempt) pending = undefined;
      },
      () => {
        if (pending === attempt) pending = undefined;
      },
    );
    return attempt;
  };
}

export interface LaunchedChromeControlOptions {
  readonly host: string;
  readonly port: number;
  readonly userDataDir: string;
  readonly processIdentity: ChromeProcessIdentity;
}

export interface RetainedChromeEndpointAuthority {
  readonly browserWSEndpoint: string;
  readonly kill: ChromeStableKill;
  release(): Promise<void>;
}

export function createEndpointBoundChildProcessChromeKill(
  child: StableChromeProcessHandle,
  exactControlKill: ChromeStableKill,
  endpointAuthority: Pick<RetainedChromeEndpointAuthority, "release">,
): ChromeStableKill {
  const processKill = createStableChildProcessChromeKill(child, exactControlKill);
  return createTerminalCachingChromeKill(async () => {
    const outcome = await processKill();
    if (!isSafeChromeTerminationOutcome(outcome)) return outcome;
    try {
      await endpointAuthority.release();
      return outcome;
    } catch (error) {
      return {
        status: "unsafe",
        pid: outcome.pid,
        reason: `Exact Chrome endpoint release failed: ${error instanceof Error ? error.message : error}`,
      };
    }
  });
}

export interface ChromeEndpointAuthorityOptions extends LaunchedChromeControlOptions {
  readonly browserWSEndpoint?: string;
}

interface ChromeEndpointAuthorityDeps {
  discoverEndpoint?: typeof discoverBrowserWebSocketEndpoint;
  connectBrowser?: (browserWSEndpoint: string) => Promise<ChromeClient>;
  inspectProcessIdentity?: typeof inspectChromeProcessIdentity;
  resolveListeningPid?: typeof resolveListeningPortOwnerPid;
}

export interface LaunchedChromeEndpointControl {
  readonly kill: ChromeStableKill;
  readonly readEndpointAuthority: () => RetainedChromeEndpointAuthority | undefined;
}

export interface LaunchedChromeControlDeps {
  inspectProcessIdentity?: typeof inspectChromeProcessIdentity;
  retainControlChannel?: (options: LaunchedChromeControlOptions) => Promise<ChromeStableKill>;
  retainEndpointAuthority?: (
    options: LaunchedChromeControlOptions,
  ) => Promise<RetainedChromeEndpointAuthority>;
}

export async function createLaunchedChromeEndpointControl(
  options: LaunchedChromeControlOptions,
  deps: LaunchedChromeControlDeps = {},
): Promise<LaunchedChromeEndpointControl> {
  const inspect = deps.inspectProcessIdentity ?? inspectChromeProcessIdentity;
  const retainEndpoint = deps.retainEndpointAuthority ?? retainChromeEndpointAuthority;
  let retainedAuthority: RetainedChromeEndpointAuthority | undefined;
  let retainedLegacyKill: ChromeStableKill | undefined;

  const retain = async (): Promise<ChromeStableKill> => {
    if (deps.retainControlChannel) {
      retainedLegacyKill ??= await deps.retainControlChannel(options);
      return retainedLegacyKill;
    }
    retainedAuthority ??= await retainEndpoint(options);
    return retainedAuthority.kill;
  };

  try {
    if ((await inspect(options.userDataDir, options.processIdentity)) === "current") {
      await retain();
    }
  } catch {
    retainedAuthority = undefined;
    retainedLegacyKill = undefined;
  }

  const kill = createTerminalCachingChromeKill(async () => {
    let inspection: ChromeProcessIdentityInspection;
    try {
      inspection = await inspect(options.userDataDir, options.processIdentity);
    } catch {
      inspection = "unavailable";
    }
    if (inspection === "exited") {
      return { status: "already-stopped", pid: options.processIdentity.pid };
    }
    if (inspection !== "current") {
      return {
        status: "unsafe",
        pid: options.processIdentity.pid,
        reason: "Exact Chrome process generation could not be reverified before control teardown",
      };
    }

    let retainedKill: ChromeStableKill;
    try {
      retainedKill = await retain();
    } catch (error) {
      return {
        status: "unsafe",
        pid: options.processIdentity.pid,
        reason: `Exact Chrome control channel is unavailable: ${error instanceof Error ? error.message : error}`,
      };
    }

    try {
      const outcome = await retainedKill();
      if (isSafeChromeTerminationOutcome(outcome) && outcome.pid !== options.processIdentity.pid) {
        if (retainedAuthority) {
          try {
            await retainedAuthority.release();
          } catch (releaseError) {
            return {
              status: "unsafe",
              pid: options.processIdentity.pid,
              reason: `Exact Chrome control channel returned a different process identity, and its endpoint release failed: ${releaseError instanceof Error ? releaseError.message : releaseError}`,
            };
          }
        }
        retainedAuthority = undefined;
        retainedLegacyKill = undefined;
        return {
          status: "unsafe",
          pid: options.processIdentity.pid,
          reason: "Exact Chrome control channel returned a different process identity",
        };
      }
      return outcome;
    } catch (error) {
      const reason = `Exact Chrome control teardown failed: ${error instanceof Error ? error.message : error}`;
      if (retainedAuthority) {
        try {
          await retainedAuthority.release();
        } catch (releaseError) {
          return {
            status: "unsafe",
            pid: options.processIdentity.pid,
            reason: `${reason}; exact endpoint release also failed: ${releaseError instanceof Error ? releaseError.message : releaseError}`,
          };
        }
      }
      retainedAuthority = undefined;
      retainedLegacyKill = undefined;
      return {
        status: "unsafe",
        pid: options.processIdentity.pid,
        reason,
      };
    }
  });

  return Object.freeze({
    kill,
    readEndpointAuthority: () => retainedAuthority,
  });
}

export async function createLaunchedChromeControlKillForTest(
  options: LaunchedChromeControlOptions,
  deps: LaunchedChromeControlDeps,
): Promise<ChromeStableKill> {
  return (await createLaunchedChromeEndpointControl(options, deps)).kill;
}

interface VerifiedDevToolsEndpoint {
  port: number;
  browserWSEndpoint: string;
}

export async function discoverBrowserWebSocketEndpoint(
  host: string,
  port: number,
): Promise<VerifiedDevToolsEndpoint> {
  await waitForDebugPort(port);
  const response = await fetch(`http://${host}:${port}/json/version`);
  if (!response.ok) {
    throw new Error(`Chrome control-channel discovery failed with HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof payload.webSocketDebuggerUrl !== "string") {
    throw new Error("Chrome did not expose an exact browser control channel");
  }
  const endpoint = new URL(payload.webSocketDebuggerUrl);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== host ||
    Number.parseInt(endpoint.port, 10) !== port ||
    !/^\/devtools\/browser\/[^/]+$/u.test(endpoint.pathname)
  ) {
    throw new Error("Chrome returned an invalid exact browser control channel");
  }
  return { port, browserWSEndpoint: endpoint.toString() };
}

export async function resolveListeningPortOwnerPid(
  port: number,
  execute: (file: string, args: string[]) => Promise<{ stdout: string }> = async (file, args) => {
    const { stdout } = await execFileAsync(file, args, { encoding: "utf8" });
    return { stdout: String(stdout ?? "") };
  },
): Promise<number | null> {
  try {
    const { stdout } = await execute("/usr/sbin/lsof", [
      "-nP",
      "-a",
      `-iTCP:${port}`,
      "-sTCP:LISTEN",
      "-Fp",
    ]);
    const pids = new Set(
      stdout
        .split(/\r?\n/u)
        .map((line) => line.match(/^p(\d+)$/u)?.[1])
        .filter((value): value is string => Boolean(value))
        .map((value) => Number.parseInt(value, 10)),
    );
    if (pids.size !== 1) return null;
    const [pid] = pids;
    return pid && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export async function verifyListeningPortOwnedByProcessForTest(
  pid: number,
  port: number,
  execute: (file: string, args: string[]) => Promise<{ stdout: string }>,
): Promise<boolean> {
  return (await resolveListeningPortOwnerPid(port, execute)) === pid;
}

interface IdentityBoundChromeControlKillDeps {
  inspectProcessIdentity?: typeof inspectChromeProcessIdentity;
  timeoutMs?: number;
  pollMs?: number;
}
export async function retainChromeEndpointAuthority(
  options: ChromeEndpointAuthorityOptions,
  deps: ChromeEndpointAuthorityDeps = {},
): Promise<RetainedChromeEndpointAuthority> {
  if (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65_535) {
    throw new Error(`Chrome control channel has an invalid DevTools port: ${options.port}`);
  }
  const endpoint = options.browserWSEndpoint
    ? { port: options.port, browserWSEndpoint: options.browserWSEndpoint }
    : await (deps.discoverEndpoint ?? discoverBrowserWebSocketEndpoint)(options.host, options.port);
  const endpointUrl = new URL(endpoint.browserWSEndpoint);
  if (
    endpoint.port !== options.port ||
    endpointUrl.protocol !== "ws:" ||
    endpointUrl.hostname !== options.host ||
    Number.parseInt(endpointUrl.port, 10) !== options.port ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.search ||
    endpointUrl.hash ||
    !/^\/devtools\/browser\/[^/]+$/u.test(endpointUrl.pathname)
  ) {
    throw new Error("Chrome returned an invalid exact browser control channel");
  }

  const client = await (deps.connectBrowser
    ? deps.connectBrowser(endpointUrl.toString())
    : (CDP({ target: endpointUrl.toString(), local: true }) as Promise<ChromeClient>));
  try {
    await client.Browser.getVersion();
    const processResult = await client.SystemInfo.getProcessInfo();
    const browserProcessMatches = Array.isArray(processResult.processInfo)
      ? processResult.processInfo.some(
          (processInfo) =>
            processInfo !== null &&
            typeof processInfo === "object" &&
            "id" in processInfo &&
            processInfo.id === options.processIdentity.pid &&
            "type" in processInfo &&
            processInfo.type === "browser",
        )
      : false;
    if (!browserProcessMatches) {
      throw new Error(
        "Chrome control channel is not bound to the captured browser process generation",
      );
    }

    const inspect = deps.inspectProcessIdentity ?? inspectChromeProcessIdentity;
    const [inspection, listeningPid] = await Promise.all([
      inspect(options.userDataDir, options.processIdentity),
      options.processIdentity.profileDirectory.platform === "darwin"
        ? (deps.resolveListeningPid ?? resolveListeningPortOwnerPid)(options.port)
        : Promise.resolve(options.processIdentity.pid),
    ]);
    if (inspection !== "current" || listeningPid !== options.processIdentity.pid) {
      throw new Error("Chrome control channel is not bound to the exact process generation");
    }

    const rawKill = createIdentityBoundChromeControlKill(
      client,
      options.userDataDir,
      options.processIdentity,
      { inspectProcessIdentity: inspect },
    );
    let released = false;
    let terminalKill: RecordedChromeTerminationOutcome | undefined;
    let pending: Promise<unknown> | undefined;

    const kill: ChromeStableKill = async () => {
      while (pending) {
        await pending.catch(() => undefined);
      }
      if (released) {
        return {
          status: "unsafe",
          pid: options.processIdentity.pid,
          reason: "Exact Chrome endpoint authority was already released",
        };
      }
      if (terminalKill) return terminalKill;
      const attempt = rawKill();
      pending = attempt;
      try {
        const outcome = await attempt;
        if (isSafeChromeTerminationOutcome(outcome)) terminalKill = outcome;
        return outcome;
      } finally {
        if (pending === attempt) pending = undefined;
      }
    };
    const release = async (): Promise<void> => {
      while (pending) {
        await pending.catch(() => undefined);
      }
      if (released || terminalKill) return;
      const attempt = Promise.resolve(client.close()).then(() => undefined);
      pending = attempt;
      try {
        await attempt;
        released = true;
      } finally {
        if (pending === attempt) pending = undefined;
      }
    };
    return Object.freeze({
      browserWSEndpoint: endpointUrl.toString(),
      kill,
      release,
    });
  } catch (error) {
    try {
      await client.close();
    } catch (releaseError) {
      throw new AggregateError(
        [
          error instanceof Error ? error : new Error(String(error)),
          releaseError instanceof Error ? releaseError : new Error(String(releaseError)),
        ],
        "Chrome endpoint authority could not be validated or released safely",
      );
    }
    throw error;
  }
}

export async function retainExactChromeEndpointAuthority(
  browserWSEndpoint: string,
  userDataDir: string,
  processIdentity: ChromeProcessIdentity,
): Promise<RetainedChromeEndpointAuthority> {
  const endpoint = new URL(browserWSEndpoint);
  return retainChromeEndpointAuthority({
    host: endpoint.hostname,
    port: Number.parseInt(endpoint.port, 10),
    browserWSEndpoint,
    userDataDir,
    processIdentity,
  });
}

function createIdentityBoundChromeControlKill(
  client: ChromeClient,
  userDataDir: string,
  processIdentity: ChromeProcessIdentity,
  deps: IdentityBoundChromeControlKillDeps,
): ChromeStableKill {
  let completed: RecordedChromeTerminationOutcome | undefined;
  let pending: Promise<RecordedChromeTerminationOutcome> | undefined;
  let closeRequested = false;
  let clientReleased = false;
  return () => {
    if (completed) return Promise.resolve(completed);
    if (pending) return pending;
    const attempt = (async (): Promise<RecordedChromeTerminationOutcome> => {
      if (!closeRequested) {
        const inspect = deps.inspectProcessIdentity ?? inspectChromeProcessIdentity;
        let current: ChromeProcessIdentityInspection;
        try {
          current = await inspect(userDataDir, processIdentity);
        } catch {
          current = "unavailable";
        }
        if (current === "exited") {
          if (!clientReleased) {
            try {
              await client.close();
              clientReleased = true;
            } catch (error) {
              return {
                status: "unsafe",
                pid: processIdentity.pid,
                reason: `Exact Chrome control channel release failed: ${error instanceof Error ? error.message : error}`,
              };
            }
          }
          completed = { status: "already-stopped", pid: processIdentity.pid };
          return completed;
        }
        if (current !== "current") {
          return {
            status: "unsafe",
            pid: processIdentity.pid,
            reason: "Exact Chrome process generation could not be reverified before Browser.close",
          };
        }
        try {
          await client.Browser.close();
          closeRequested = true;
        } catch (error) {
          return {
            status: "unsafe",
            pid: processIdentity.pid,
            reason: `Exact Chrome control channel failed: ${error instanceof Error ? error.message : error}`,
          };
        }
      }
      const inspection = await waitForExactChromeProcessExit(userDataDir, processIdentity, deps);
      if (inspection === "exited") {
        if (!clientReleased) {
          try {
            await client.close();
            clientReleased = true;
          } catch (error) {
            return {
              status: "unsafe",
              pid: processIdentity.pid,
              reason: `Exact Chrome control channel release failed: ${error instanceof Error ? error.message : error}`,
            };
          }
        }
        completed = {
          status: "stopped",
          pid: processIdentity.pid,
          signal: "CONTROL_CHANNEL",
        };
        return completed;
      }
      return {
        status: "unsafe",
        pid: processIdentity.pid,
        reason:
          inspection === "current"
            ? "Exact Chrome process generation remained alive after Browser.close"
            : "Exact Chrome process generation exit could not be proven",
      };
    })();
    pending = attempt;
    void attempt.then(
      () => {
        if (pending === attempt) pending = undefined;
      },
      () => {
        if (pending === attempt) pending = undefined;
      },
    );
    return attempt;
  };
}

export function createIdentityBoundChromeControlKillForTest(
  client: ChromeClient,
  userDataDir: string,
  processIdentity: ChromeProcessIdentity,
  deps: IdentityBoundChromeControlKillDeps,
): ChromeStableKill {
  return createIdentityBoundChromeControlKill(client, userDataDir, processIdentity, deps);
}

async function waitForExactChromeProcessExit(
  userDataDir: string,
  processIdentity: ChromeProcessIdentity,
  deps: IdentityBoundChromeControlKillDeps,
): Promise<ChromeProcessIdentityInspection> {
  const inspect = deps.inspectProcessIdentity ?? inspectChromeProcessIdentity;
  const deadline = Date.now() + (deps.timeoutMs ?? 5_000);
  let latest: ChromeProcessIdentityInspection = "unavailable";
  do {
    try {
      latest = await inspect(userDataDir, processIdentity);
    } catch {
      latest = "unavailable";
    }
    if (latest === "exited" || Date.now() >= deadline) return latest;
    await delay(deps.pollMs ?? 100);
  } while (Date.now() <= deadline);
  return latest;
}
export async function waitForDebugPort(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await delay(250);
  }
  throw new Error(`Timed out waiting for hidden Chrome on port ${port}.`);
}
