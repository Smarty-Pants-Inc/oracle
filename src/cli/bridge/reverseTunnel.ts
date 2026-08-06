import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import type { Server as NetServer, Socket as NetSocket } from "node:net";
import os from "node:os";
import path from "node:path";
import { checkRemoteHealth } from "../../remote/health.js";
import type { RemoteHealthResult } from "../../remote/health.js";
import { resolveWindowsOpenSshExecutable } from "../../windowsSystemExecutable.js";
import { BRIDGE_HOST_READINESS_TIMEOUT_MS } from "./childProtocol.js";
import type { BridgeHostSpawn } from "./childProtocol.js";

const REVERSE_TUNNEL_SHUTDOWN_TIMEOUT_MS = 5_000;
type SpawnOpenSsh = (args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface ReverseTunnelHandle {
  ready: Promise<void>;
  stop: () => void | Promise<void>;
}

export interface ReverseTunnelOptions {
  sshTarget: string;
  remotePort: number;
  localPort: number;
  token: string;
  identity?: string;
  extraArgs?: string;
  log: (message: string) => void;
  platform?: NodeJS.Platform;
  spawnSsh?: BridgeHostSpawn;
  shutdownTimeoutMs?: number;
}

export type StartReverseTunnel = (
  options: ReverseTunnelOptions,
) => ReverseTunnelHandle | Promise<ReverseTunnelHandle>;

interface ReverseTunnelProbeSnapshot {
  child: ChildProcess | null;
  server: NetServer | null;
  socket: NetSocket | null;
  closed: Promise<void>;
}

interface ReverseTunnelProbeState {
  child: ChildProcess | null;
  server: NetServer | null;
  socket: NetSocket | null;
  closing: ReverseTunnelProbeSnapshot | null;
  retainForLifecycleDrain: boolean;
}

function beginReverseTunnelProbeClose(
  state: ReverseTunnelProbeState,
  expectedServer?: NetServer,
): ReverseTunnelProbeSnapshot | null {
  if (state.closing && (!expectedServer || state.closing.server === expectedServer)) {
    return state.closing;
  }
  if (expectedServer && state.server !== expectedServer) return null;

  const server = state.server;
  const socket = state.socket;
  socket?.destroy();
  const closed = server
    ? new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      })
    : Promise.resolve();
  const snapshot: ReverseTunnelProbeSnapshot = {
    child: state.child,
    server,
    socket,
    closed,
  };
  state.closing = snapshot;
  return snapshot;
}

function clearReverseTunnelProbe(
  state: ReverseTunnelProbeState,
  snapshot: ReverseTunnelProbeSnapshot,
): void {
  if (state.child === snapshot.child) state.child = null;
  if (state.server === snapshot.server) state.server = null;
  if (state.socket === snapshot.socket) state.socket = null;
  if (state.closing === snapshot) state.closing = null;
}

async function closeReverseTunnelProbe(
  state: ReverseTunnelProbeState,
  terminateChildren: (children: readonly ChildProcess[]) => Promise<void>,
  expectedServer?: NetServer,
): Promise<void> {
  const snapshot = beginReverseTunnelProbeClose(state, expectedServer);
  if (!snapshot) return;
  await Promise.all([
    snapshot.child ? terminateChildren([snapshot.child]) : Promise.resolve(),
    snapshot.closed,
  ]);
  if (!state.retainForLifecycleDrain) clearReverseTunnelProbe(state, snapshot);
}

function assertWindowsSshExtraArgs(args: readonly string[]): void {
  const isControlOption = (value: string): boolean =>
    /^(?:controlmaster|controlpath|controlpersist)(?:=|\s|$)/iu.test(value);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (
      arg.startsWith("-M") ||
      arg.startsWith("-S") ||
      arg.startsWith("-O") ||
      (arg.startsWith("-o") && arg.length > 2 && isControlOption(arg.slice(2))) ||
      (arg === "-o" && isControlOption(args[index + 1] ?? ""))
    ) {
      throw new Error(
        "Native Windows OpenSSH bridge tunnels do not accept ControlMaster, ControlPath, ControlPersist, -M, -S, or -O options.",
      );
    }
  }
}

async function probeReverseTunnelHealth({
  sshTarget,
  spawnOpenSsh,
  remotePort,
  token,
  identity,
  extraArgs,
  timeoutMs,
  trackChild,
  terminateChildren,
  state,
}: {
  sshTarget: string;
  remotePort: number;
  token: string;
  identity?: string;
  extraArgs: readonly string[];
  timeoutMs: number;
  spawnOpenSsh: SpawnOpenSsh;
  trackChild: (child: ChildProcess) => ChildProcess;
  terminateChildren: (children: readonly ChildProcess[]) => Promise<void>;
  state: ReverseTunnelProbeState;
}): Promise<RemoteHealthResult> {
  const server = net.createServer();
  state.server = server;
  state.closing = null;
  server.on("error", () => state.socket?.destroy());
  let accepted = false;
  server.on("connection", (socket) => {
    if (accepted || state.server !== server) {
      socket.destroy();
      return;
    }
    accepted = true;
    state.socket = socket;
    socket.on("error", () => undefined);
    const probeArgs = ["-W", `127.0.0.1:${remotePort}`];
    if (identity) probeArgs.push("-i", identity);
    probeArgs.push(...extraArgs, sshTarget);
    let child: ChildProcess;
    try {
      child = trackChild(
        spawnOpenSsh(probeArgs, {
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
        }),
      );
    } catch (error) {
      socket.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    state.child = child;
    if (!child.stdin || !child.stdout) {
      socket.destroy(new Error("SSH bridge health probe started without stdio pipes."));
      return;
    }
    child.stdin.on("error", () => socket.destroy());
    child.stdout.on("error", () => socket.destroy());
    child.once("error", () => socket.destroy());
    child.once("exit", () => socket.destroy());
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("SSH bridge health probe did not acquire a loopback port.");
    }
    return await checkRemoteHealth({
      host: `127.0.0.1:${address.port}`,
      token,
      timeoutMs,
      idleTimeoutMs: timeoutMs,
    });
  } finally {
    await closeReverseTunnelProbe(state, terminateChildren, server);
  }
}

export function startReverseTunnel({
  sshTarget,
  remotePort,
  localPort,
  token,
  identity,
  extraArgs,
  log,
  platform = process.platform,
  spawnSsh = (command, args, options) => spawn(command, args, options),
  shutdownTimeoutMs = REVERSE_TUNNEL_SHUTDOWN_TIMEOUT_MS,
}: ReverseTunnelOptions): ReverseTunnelHandle {
  const initialReady = Promise.withResolvers<void>();
  const parsedExtraArgs = extraArgs ? splitArgs(extraArgs) : [];
  if (platform === "win32") assertWindowsSshExtraArgs(parsedExtraArgs);
  const sshExecutable = platform === "win32" ? resolveWindowsOpenSshExecutable() : "ssh";
  const spawnOpenSsh: SpawnOpenSsh = (args, options) => spawnSsh(sshExecutable, args, options);
  const probeState: ReverseTunnelProbeState = {
    child: null,
    server: null,
    socket: null,
    closing: null,
    retainForLifecycleDrain: false,
  };
  const liveChildren = new Set<ChildProcess>();
  const childTerminations = new Map<ChildProcess, Promise<void>>();
  let stopped = false;
  let becameReady = false;
  let master: ChildProcess | null = null;
  let controlChild: ChildProcess | null = null;
  let controlDir: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  let attempt = 0;
  let lifecycleDrain: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let activeRun: Promise<void> | null = null;

  const trackChild = (child: ChildProcess): ChildProcess => {
    liveChildren.add(child);
    child.once("close", () => liveChildren.delete(child));
    return child;
  };
  const waitForChildTermination = (child: ChildProcess): Promise<boolean> => {
    if (!liveChildren.has(child)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (terminated: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off("close", onTermination);
        resolve(terminated);
      };
      const onTermination = () => settle(true);
      const timeout = setTimeout(() => settle(false), shutdownTimeoutMs);
      child.once("close", onTermination);
    });
  };
  const signalAndWaitForChild = async (
    child: ChildProcess,
    signal: NodeJS.Signals,
  ): Promise<boolean> => {
    if (!liveChildren.has(child)) return true;
    const terminated = waitForChildTermination(child);
    try {
      child.kill(signal);
    } catch {
      // The bounded wait below decides whether force escalation is still required.
    }
    return await terminated;
  };
  const terminateChild = (child: ChildProcess): Promise<void> => {
    const existing = childTerminations.get(child);
    if (existing) return existing;
    const termination = (async () => {
      if (!liveChildren.has(child)) return;
      if (await signalAndWaitForChild(child, "SIGTERM")) return;
      if (await signalAndWaitForChild(child, "SIGKILL")) return;
      throw new Error("SSH reverse tunnel child did not exit after forced termination.");
    })();
    childTerminations.set(child, termination);
    void termination.finally(() => childTerminations.delete(child)).catch(() => undefined);
    return termination;
  };
  const terminateChildren = async (children: readonly ChildProcess[]): Promise<void> => {
    const uniqueChildren = [...new Set(children)];
    const results = await Promise.allSettled(uniqueChildren.map((child) => terminateChild(child)));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "SSH reverse tunnel children could not be confirmed stopped.",
      );
    }
  };
  const cleanupControlDir = async (): Promise<void> => {
    const current = controlDir;
    controlDir = null;
    if (current) await fs.rm(current, { recursive: true, force: true }).catch(() => undefined);
  };
  const shutdownCurrentProcesses = (): Promise<void> => {
    if (lifecycleDrain) return lifecycleDrain;
    probeState.retainForLifecycleDrain = true;
    const masterSnapshot = master;
    const controlSnapshot = controlChild;
    const probeSnapshot = beginReverseTunnelProbeClose(probeState);
    const children = [
      ...liveChildren,
      ...(masterSnapshot ? [masterSnapshot] : []),
      ...(controlSnapshot ? [controlSnapshot] : []),
      ...(probeSnapshot?.child ? [probeSnapshot.child] : []),
    ];
    lifecycleDrain = (async () => {
      try {
        await Promise.all([
          terminateChildren(children),
          probeSnapshot?.closed ?? Promise.resolve(),
        ]);
        if (master === masterSnapshot) master = null;
        if (controlChild === controlSnapshot) controlChild = null;
        if (probeSnapshot) clearReverseTunnelProbe(probeState, probeSnapshot);
        await cleanupControlDir();
      } finally {
        probeState.retainForLifecycleDrain = false;
      }
    })();
    return lifecycleDrain;
  };
  const scheduleRestart = (): void => {
    if (stopped) return;
    const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
    attempt += 1;
    log(`[bridge host] ssh tunnel exited; restarting in ${delayMs}ms`);
    timer = setTimeout(() => launchSpawn(), delayMs);
    timer.unref?.();
  };
  const markReady = (currentMaster: ChildProcess): void => {
    attempt = 0;
    log(
      `[bridge host] ssh reverse tunnel ready${currentMaster.pid ? ` (pid ${currentMaster.pid})` : ""}: ${sshTarget}`,
    );
    if (!becameReady) {
      becameReady = true;
      initialReady.resolve();
    }
  };
  const runControlCommand = (args: string[]): Promise<number> => {
    const result = Promise.withResolvers<number>();
    let settled = false;
    let timeout: NodeJS.Timeout;
    const child = trackChild(spawnOpenSsh(args, { stdio: "ignore", windowsHide: true }));
    controlChild = child;
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      if (controlChild === child && !liveChildren.has(child)) controlChild = null;
      clearTimeout(timeout);
      result.resolve(code);
    };
    timeout = setTimeout(() => {
      void terminateChild(child).then(
        () => settle(255),
        () => settle(255),
      );
    }, 2_000);
    child.once("error", () => settle(255));
    child.once("exit", (code) => settle(code ?? 255));
    return result.promise;
  };
  const waitForAuthenticatedHealth = async (
    currentMaster: ChildProcess,
    masterClosed: Promise<void>,
    deadline: number,
  ): Promise<void> => {
    while (!stopped && Date.now() < deadline) {
      const remainingMs = Math.max(1, deadline - Date.now());
      const result = await Promise.race([
        probeReverseTunnelHealth({
          sshTarget,
          spawnOpenSsh,
          remotePort,
          token,
          identity,
          extraArgs: parsedExtraArgs,
          timeoutMs: Math.min(5_000, remainingMs),
          trackChild,
          terminateChildren,
          state: probeState,
        }).then((health) => ({ type: "health" as const, health })),
        masterClosed.then(() => ({ type: "master-closed" as const })),
      ]);
      if (result.type === "master-closed") {
        throw new Error("Reverse SSH tunnel exited before remote health readiness.");
      }
      if (
        result.health.ok &&
        result.health.protocol === "transaction-v3" &&
        result.health.serverGeneration &&
        !stopped &&
        currentMaster.exitCode === null &&
        currentMaster.signalCode === null
      ) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Reverse SSH tunnel remote authenticated health did not become ready.");
  };

  const runWindowsTunnel = async (): Promise<void> => {
    const masterArgs = [
      "-N",
      "-R",
      `${remotePort}:127.0.0.1:${localPort}`,
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
    ];
    if (identity) masterArgs.push("-i", identity);
    masterArgs.push(...parsedExtraArgs, sshTarget);
    master = trackChild(spawnOpenSsh(masterArgs, { stdio: "ignore", windowsHide: true }));
    const currentMaster = master;
    const masterClosed = Promise.withResolvers<void>();
    currentMaster.once("error", () => masterClosed.resolve());
    currentMaster.once("close", () => masterClosed.resolve());

    const deadline = Date.now() + BRIDGE_HOST_READINESS_TIMEOUT_MS;
    await waitForAuthenticatedHealth(currentMaster, masterClosed.promise, deadline);
    markReady(currentMaster);
    await masterClosed.promise;
    if (master === currentMaster) master = null;
  };

  const runPosixTunnel = async (): Promise<void> => {
    controlDir = await fs.mkdtemp(path.join(os.tmpdir(), "o-ssh-"));
    await fs.chmod(controlDir, 0o700);
    if (stopped) {
      await cleanupControlDir();
      return;
    }
    const controlPath = path.join(controlDir, "ctl");
    const masterArgs = [
      "-M",
      "-S",
      controlPath,
      "-N",
      "-o",
      "ControlMaster=yes",
      "-o",
      "ControlPersist=no",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
    ];
    if (identity) masterArgs.push("-i", identity);
    masterArgs.push(...parsedExtraArgs, sshTarget);

    master = trackChild(spawnOpenSsh(masterArgs, { stdio: "ignore", windowsHide: true }));
    const currentMaster = master;
    const masterClosed = Promise.withResolvers<void>();
    currentMaster.once("error", () => masterClosed.resolve());
    currentMaster.once("close", () => masterClosed.resolve());

    const deadline = Date.now() + BRIDGE_HOST_READINESS_TIMEOUT_MS;
    let controlReady = false;
    while (!stopped && Date.now() < deadline) {
      const result = await Promise.race([
        runControlCommand(["-S", controlPath, "-O", "check", sshTarget]).then((code) => ({
          type: "control" as const,
          code,
        })),
        masterClosed.promise.then(() => ({ type: "master-closed" as const })),
      ]);
      if (result.type === "master-closed") {
        throw new Error("Reverse SSH tunnel master exited before readiness.");
      }
      if (result.code === 0) {
        controlReady = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (!controlReady || stopped) {
      throw new Error("Reverse SSH tunnel control socket did not become ready.");
    }

    const forwardResult = await Promise.race([
      runControlCommand([
        "-S",
        controlPath,
        "-o",
        "ExitOnForwardFailure=yes",
        "-O",
        "forward",
        "-R",
        `${remotePort}:127.0.0.1:${localPort}`,
        sshTarget,
      ]).then((code) => ({ type: "forward" as const, code })),
      masterClosed.promise.then(() => ({ type: "master-closed" as const })),
    ]);
    if (
      forwardResult.type !== "forward" ||
      forwardResult.code !== 0 ||
      stopped ||
      currentMaster.exitCode !== null ||
      currentMaster.signalCode !== null
    ) {
      throw new Error("Reverse SSH tunnel forwarding request failed.");
    }

    await waitForAuthenticatedHealth(currentMaster, masterClosed.promise, deadline);
    markReady(currentMaster);
    await masterClosed.promise;
    if (master === currentMaster) master = null;
    await cleanupControlDir();
  };

  const spawnOnce = async (): Promise<void> => {
    if (stopped) return;
    lifecycleDrain = null;
    try {
      if (platform === "win32") {
        await runWindowsTunnel();
      } else {
        await runPosixTunnel();
      }
      scheduleRestart();
    } catch {
      try {
        await shutdownCurrentProcesses();
      } catch {
        if (!becameReady) {
          initialReady.reject(
            new Error("Reverse SSH tunnel failed before the remote forward was ready."),
          );
        }
        return;
      }
      if (!becameReady) {
        initialReady.reject(
          new Error("Reverse SSH tunnel failed before the remote forward was ready."),
        );
        return;
      }
      if (!stopped) scheduleRestart();
    }
  };
  const launchSpawn = (): void => {
    if (activeRun) return;
    const run = spawnOnce();
    activeRun = run;
    void run
      .finally(() => {
        if (activeRun === run) activeRun = null;
      })
      .catch(() => undefined);
  };

  launchSpawn();
  return {
    ready: initialReady.promise,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!becameReady) {
        initialReady.reject(new Error("Reverse SSH tunnel stopped before readiness."));
      }
      const run = activeRun;
      stopPromise = Promise.all([shutdownCurrentProcesses(), run ?? Promise.resolve()]).then(
        () => undefined,
      );
      return stopPromise;
    },
  };
}

function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  const push = () => {
    const trimmed = current.trim();
    if (trimmed.length) args.push(trimmed);
    current = "";
  };

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] ?? "";
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return args;
}
