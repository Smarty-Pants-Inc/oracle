import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  BRIDGE_HOST_CREDENTIAL_PAYLOAD_MAX_BYTES,
  runBridgeHost,
} from "../../src/cli/bridge/host.js";
import { startReverseTunnel } from "../../src/cli/bridge/reverseTunnel.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";
import type { RemoteServerLifecycle, RemoteServerOptions } from "../../src/remote/server.js";
import {
  REMOTE_HEALTH_CLIENT_NONCE_HEADER,
  createRemoteHealthAuthenticationProof,
} from "../../src/remote/auth.js";
import * as fsDurability from "../../src/fsDurability.js";
import * as sessionManager from "../../src/sessionManager.js";

const MODERN_TOKEN = "a".repeat(64);
const LEGACY_TOKEN = "b".repeat(64);
const READINESS_NONCE = "11111111-1111-4111-8111-111111111111";
const OTHER_NONCE = "22222222-2222-4222-8222-222222222222";

interface FakeBridgeChild {
  child: ChildProcess;
  stdinWrites: Buffer[];
  stdinUnref: Mock;
  readinessUnref: Mock;
  unref: Mock;
  kill: Mock;
  exit: (code?: number | null, signal?: NodeJS.Signals | null) => void;
}

function createFakeBridgeChild(
  onCredentials: (payload: string, readiness: Readable) => void | Promise<void>,
  pid = 4242,
): FakeBridgeChild {
  const stdinWrites: Buffer[] = [];
  const readiness = new Readable({ read() {} });
  const readinessUnref = vi.fn();
  Object.assign(readiness, { unref: readinessUnref });
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      stdinWrites.push(Buffer.from(chunk as Uint8Array));
      callback();
    },
  });
  const stdinUnref = vi.fn();
  Object.assign(stdin, { unref: stdinUnref });
  stdin.once("finish", () => {
    void Promise.resolve(
      onCredentials(Buffer.concat(stdinWrites).toString("utf8"), readiness),
    ).catch((error: unknown) =>
      readiness.destroy(error instanceof Error ? error : new Error(String(error))),
    );
  });

  const emitter = new EventEmitter();
  let exited = false;
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  const exit = (code: number | null = null, signal: NodeJS.Signals | null = "SIGTERM") => {
    if (exited) return;
    exited = true;
    exitCode = code;
    signalCode = signal;
    emitter.emit("exit", code, signal);
  };
  const unref = vi.fn();
  const kill = vi.fn((signal?: NodeJS.Signals) => {
    exit(null, signal ?? "SIGTERM");
    return true;
  });
  Object.assign(emitter, {
    pid,
    stdin,
    stdio: [stdin, null, null, readiness],
    stdout: null,
    stderr: null,
    unref,
    kill,
  });
  Object.defineProperties(emitter, {
    exitCode: { configurable: true, get: () => exitCode },
    signalCode: { configurable: true, get: () => signalCode },
  });
  const child = emitter as unknown as ChildProcess;
  return { child, stdinWrites, stdinUnref, readinessUnref, unref, kill, exit };
}

function credentialPayload(
  input: {
    readinessNonce?: string;
    token?: string;
    legacyToken?: string;
  } = {},
): string {
  return `${JSON.stringify({
    version: 1,
    readinessNonce: input.readinessNonce ?? READINESS_NONCE,
    token: input.token ?? MODERN_TOKEN,
    ...(input.legacyToken === undefined ? {} : { legacyToken: input.legacyToken }),
  })}\n`;
}

function readinessPayload(readinessNonce: string, status: "ready" | "failed" = "ready"): string {
  return `${JSON.stringify({ version: 1, readinessNonce, status })}\n`;
}

interface FakeSshChild {
  child: ChildProcess;
  kill: Mock;
  exit: (code?: number) => void;
}

function createFakeSshChild(io?: net.Socket, pid = 5000): FakeSshChild {
  const emitter = new EventEmitter();
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  let exited = false;
  const emitExit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    exitCode = code;
    signalCode = signal;
    io?.destroy();
    emitter.emit("exit", code, signal);
    emitter.emit("close", code, signal);
  };
  const kill = vi.fn(() => {
    if (exited) return false;
    emitExit(null, "SIGTERM");
    return true;
  });
  Object.assign(emitter, {
    pid,
    stdin: io ?? null,
    stdout: io ?? null,
    stderr: null,
    stdio: [io ?? null, io ?? null, null, null, null],
    kill,
  });
  Object.defineProperties(emitter, {
    exitCode: { get: () => exitCode },
    signalCode: { get: () => signalCode },
  });
  return {
    child: emitter as unknown as ChildProcess,
    kill,
    exit: (code = 1) => emitExit(code, null),
  };
}

function createFakeSshTunnelHarness(platform: NodeJS.Platform, healthPort: number) {
  const sshArgs: Array<readonly string[]> = [];
  const sshChildren: FakeSshChild[] = [];
  const mainChildren: FakeSshChild[] = [];
  const controlChildren: FakeSshChild[] = [];
  const probeChildren: FakeSshChild[] = [];
  const tunnelSpawn = vi.fn(
    (_command: string, args: readonly string[], _options: SpawnOptions): ChildProcess => {
      sshArgs.push([...args]);
      const isProbe = args[0] === "-W";
      const isControl = platform !== "win32" && args.includes("-O");
      const child = createFakeSshChild(
        isProbe ? net.createConnection({ host: "127.0.0.1", port: healthPort }) : undefined,
        5000 + sshChildren.length,
      );
      sshChildren.push(child);
      if (isProbe) {
        probeChildren.push(child);
      } else if (isControl) {
        controlChildren.push(child);
        queueMicrotask(() => child.exit(0));
      } else {
        mainChildren.push(child);
      }
      return child.child;
    },
  );
  return {
    tunnelSpawn,
    sshArgs,
    sshChildren,
    mainChildren,
    controlChildren,
    probeChildren,
  };
}

async function listenLoopback(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function writeHealthResponse(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rootKey: string,
): void {
  const clientNonce = String(req.headers[REMOTE_HEALTH_CLIENT_NONCE_HEADER] ?? "");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      version: "ssh-contract",
      uptimeSeconds: 1,
      capabilities: {
        artifactTransfer: true,
        artifactProtocolVersion: 1,
        transactionProtocolVersion: 3,
        maxArtifactBytes: 1,
        maxRequestBytes: 1,
        maxAttachmentBytes: 1,
        maxTotalAttachmentBytes: 1,
        maxAttachments: 1,
        maxPromptChars: 1,
        transportSecurity: "loopback-http",
        boundedRequestDeadlines: true,
        boundedTransactionStore: true,
      },
      authentication: createRemoteHealthAuthenticationProof({
        rootKey,
        serverGeneration: "ssh-contract-generation",
        clientNonce,
      }),
    }),
  );
}

function expectNativeWindowsSshArgs(calls: Array<readonly string[]>): void {
  expect(calls[0]).toEqual([
    "-N",
    "-R",
    "9473:127.0.0.1:9473",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "synthetic-host",
  ]);
  expect(calls.some((args) => args[0] === "-W" && args[1] === "127.0.0.1:9473")).toBe(true);
  for (const args of calls) {
    expect(args).not.toContain("-M");
    expect(args).not.toContain("-S");
    expect(args).not.toContain("-O");
    expect(args.some((arg) => /^Control(?:Master|Path|Persist)/iu.test(arg))).toBe(false);
  }
}

function expectPosixSshArgs(calls: Array<readonly string[]>): void {
  const controlPath = calls[0]?.[2];
  expect(typeof controlPath).toBe("string");
  expect(path.basename(controlPath!)).toBe("ctl");
  expect(calls[0]).toEqual([
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
    "synthetic-host",
  ]);
  expect(calls[1]).toEqual(["-S", controlPath, "-O", "check", "synthetic-host"]);
  expect(calls[2]).toEqual([
    "-S",
    controlPath,
    "-o",
    "ExitOnForwardFailure=yes",
    "-O",
    "forward",
    "-R",
    "9473:127.0.0.1:9473",
    "synthetic-host",
  ]);
  expect(calls.some((args) => args[0] === "-W" && args[1] === "127.0.0.1:9473")).toBe(true);
}

afterEach(() => {
  setOracleHomeDirOverrideForTest(null);
  vi.restoreAllMocks();
});

describe("bridge host detached child transport", () => {
  it("keeps both credentials out of child argv/env and transfers one exact closed payload", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-host-ipc-"));
    const artifactPath = path.join(tempDir, "connection.json");
    const pidPath = path.join(tempDir, "bridge-host.pid");
    setOracleHomeDirOverrideForTest(tempDir);
    let publishedBeforeReady = false;
    const harness = createFakeBridgeChild(async (payload, readiness) => {
      publishedBeforeReady = await Promise.all([
        fs.access(artifactPath).then(
          () => true,
          () => false,
        ),
        fs.access(pidPath).then(
          () => true,
          () => false,
        ),
      ]).then((results) => results.some(Boolean));
      const parsed = JSON.parse(payload) as { readinessNonce: string };
      readiness.push(readinessPayload(parsed.readinessNonce));
      readiness.push(null);
    });
    const spawnChild = vi.fn(
      (_command: string, _args: readonly string[], _options: SpawnOptions) => harness.child,
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await runBridgeHost(
        {
          background: true,
          bind: "127.0.0.1:9473",
          token: MODERN_TOKEN,
          legacyToken: LEGACY_TOKEN,
          writeConnection: artifactPath,
        },
        {
          spawn: spawnChild,
          generateReadinessNonce: () => READINESS_NONCE,
          env: {
            SAFE_VALUE: "kept",
            ORACLE_REMOTE_TOKEN: MODERN_TOKEN,
            ORACLE_REMOTE_LEGACY_TOKEN: LEGACY_TOKEN,
            oracle_remote_token: "case-insensitive-name",
            WRAPPED_SECRET: `prefix-${MODERN_TOKEN}-suffix`,
            [LEGACY_TOKEN]: "secret-in-name",
          },
        },
      );

      expect(spawnChild).toHaveBeenCalledOnce();
      const [command, args, spawnOptions] = spawnChild.mock.calls[0]!;
      expect(command).toBe(process.execPath);
      expect(args).toEqual([
        process.argv[1],
        "bridge",
        "host",
        "--background-child",
        "--bind",
        "127.0.0.1:9473",
      ]);
      expect(args).not.toContain("--token");
      expect(args).not.toContain("--legacy-token");
      expect(args).not.toContain("--write-connection");
      expect(args).not.toContain("--foreground");
      expect(JSON.stringify(args)).not.toContain(MODERN_TOKEN);
      expect(JSON.stringify(args)).not.toContain(LEGACY_TOKEN);
      expect(JSON.stringify(args)).not.toContain(READINESS_NONCE);
      expect(spawnOptions.detached).toBe(true);
      expect(spawnOptions.stdio).toEqual(["pipe", expect.any(Number), expect.any(Number), "pipe"]);
      expect(spawnOptions.env).toEqual({ SAFE_VALUE: "kept" });

      expect(publishedBeforeReady).toBe(false);
      expect(harness.stdinWrites).toHaveLength(1);
      expect(Buffer.concat(harness.stdinWrites).toString("utf8")).toBe(
        credentialPayload({ legacyToken: LEGACY_TOKEN }),
      );
      expect(harness.child.stdin?.writableEnded).toBe(true);
      expect(harness.stdinUnref).toHaveBeenCalledOnce();
      expect(harness.readinessUnref).toHaveBeenCalledOnce();
      expect(harness.unref).toHaveBeenCalledOnce();
      expect(harness.kill).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(artifactPath, "utf8"))).toMatchObject({
        remoteToken: MODERN_TOKEN,
      });
      expect(await fs.readFile(pidPath, "utf8")).toBe("4242\n");
      expect(log.mock.calls.flat().join("\n")).toContain("Bridge host running in background");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires authenticated readiness before replacing prior artifact or pid state", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-host-not-ready-"));
    const artifactPath = path.join(tempDir, "connection.json");
    const pidPath = path.join(tempDir, "bridge-host.pid");
    const oldArtifact = '{"old":true}\n';
    const oldPid = "31337\n";
    await fs.writeFile(artifactPath, oldArtifact);
    await fs.writeFile(pidPath, oldPid);
    setOracleHomeDirOverrideForTest(tempDir);
    const harness = createFakeBridgeChild((_payload, readiness) => {
      readiness.push(readinessPayload(OTHER_NONCE));
      readiness.push(null);
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(
        runBridgeHost(
          {
            background: true,
            token: MODERN_TOKEN,
            writeConnection: artifactPath,
          },
          {
            spawn: () => harness.child,
            generateReadinessNonce: () => READINESS_NONCE,
          },
        ),
      ).rejects.toThrow(/did not authenticate readiness/i);
      expect(harness.kill).toHaveBeenCalledOnce();
      expect(await fs.readFile(artifactPath, "utf8")).toBe(oldArtifact);
      expect(await fs.readFile(pidPath, "utf8")).toBe(oldPid);
      expect(log.mock.calls.flat().join("\n")).not.toContain("running in background");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "early child exit", expected: /exited before readiness/i },
    { name: "authenticated failed response", expected: /reported that startup failed/i },
    { name: "readiness timeout", expected: /readiness timed out/i },
  ])("preserves prior state on $name", async ({ name, expected }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-host-failure-"));
    const artifactPath = path.join(tempDir, "connection.json");
    const pidPath = path.join(tempDir, "bridge-host.pid");
    const oldArtifact = '{"old":"artifact"}\n';
    const oldPid = "9191\n";
    await fs.writeFile(artifactPath, oldArtifact);
    await fs.writeFile(pidPath, oldPid);
    setOracleHomeDirOverrideForTest(tempDir);
    let harness: FakeBridgeChild;
    harness = createFakeBridgeChild((_payload, readiness) => {
      if (name === "early child exit") {
        Object.defineProperty(harness.child, "exitCode", {
          configurable: true,
          value: 1,
          writable: true,
        });
        harness.child.emit("exit", 1, null);
        readiness.push(null);
        return;
      }
      if (name === "authenticated failed response") {
        readiness.push(readinessPayload(READINESS_NONCE, "failed"));
        readiness.push(null);
      }
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(
        runBridgeHost(
          { background: true, token: MODERN_TOKEN, writeConnection: artifactPath },
          {
            spawn: () => harness.child,
            generateReadinessNonce: () => READINESS_NONCE,
            readinessTimeoutMs: name === "readiness timeout" ? 5 : 1_000,
          },
        ),
      ).rejects.toThrow(expected);
      expect(harness.kill).toHaveBeenCalledTimes(name === "early child exit" ? 0 : 1);
      expect(await fs.readFile(artifactPath, "utf8")).toBe(oldArtifact);
      expect(await fs.readFile(pidPath, "utf8")).toBe(oldPid);
      expect(log.mock.calls.flat().join("\n")).not.toContain("running in background");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("restores both files when a ready child exits during publication", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-host-publish-race-"));
    const artifactPath = path.join(tempDir, "connection.json");
    const pidPath = path.join(tempDir, "bridge-host.pid");
    const oldArtifact = '{"old":"artifact"}\n';
    const oldPid = "8181\n";
    await fs.writeFile(artifactPath, oldArtifact);
    await fs.writeFile(pidPath, oldPid);
    setOracleHomeDirOverrideForTest(tempDir);
    const harness = createFakeBridgeChild((_payload, readiness) => {
      readiness.push(readinessPayload(READINESS_NONCE));
      readiness.push(null);
    });
    const exitCodes: Array<number | null> = [null, null, null, 1];
    let exitCodeReads = 0;
    Object.defineProperty(harness.child, "exitCode", {
      configurable: true,
      get: () => exitCodes[Math.min(exitCodeReads++, exitCodes.length - 1)]!,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(
        runBridgeHost(
          { background: true, token: MODERN_TOKEN, writeConnection: artifactPath },
          {
            spawn: () => harness.child,
            generateReadinessNonce: () => READINESS_NONCE,
          },
        ),
      ).rejects.toThrow(/exited during state publication/i);
      expect(await fs.readFile(artifactPath, "utf8")).toBe(oldArtifact);
      expect(await fs.readFile(pidPath, "utf8")).toBe(oldPid);
      expect(log.mock.calls.flat().join("\n")).not.toContain("running in background");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("waits for the ready child tree to stop before rolling back a durable publication failure", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-host-durable-failure-"));
    const artifactPath = path.join(tempDir, "connection.json");
    const pidPath = path.join(tempDir, "bridge-host.pid");
    const oldArtifact = '{"old":"artifact"}\n';
    const oldPid = "8181\n";
    await fs.writeFile(artifactPath, oldArtifact);
    await fs.writeFile(pidPath, oldPid);
    setOracleHomeDirOverrideForTest(tempDir);
    const harness = createFakeBridgeChild((_payload, readiness) => {
      readiness.push(readinessPayload(READINESS_NONCE));
      readiness.push(null);
    }, 0);
    const shutdownRequested = Promise.withResolvers<void>();
    let tunnelLive = true;
    harness.kill.mockImplementation(() => {
      shutdownRequested.resolve();
      return true;
    });
    const durableWrite = sessionManager.writeFileAtomicDurable;
    let failPublishedArtifact = true;
    let rollbackStarted = false;
    vi.spyOn(sessionManager, "writeFileAtomicDurable").mockImplementation(
      async (targetPath, data, mode) => {
        if (targetPath === artifactPath && !failPublishedArtifact) rollbackStarted = true;
        await durableWrite(targetPath, data, mode);
        if (targetPath === artifactPath && failPublishedArtifact) {
          failPublishedArtifact = false;
          throw new Error("injected directory sync failure after artifact publication");
        }
      },
    );
    const syncDirectory = vi.spyOn(fsDurability, "syncDirectory");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const publication = runBridgeHost(
        { background: true, token: MODERN_TOKEN, writeConnection: artifactPath },
        {
          spawn: () => harness.child,
          generateReadinessNonce: () => READINESS_NONCE,
        },
      );
      await shutdownRequested.promise;
      expect(tunnelLive).toBe(true);
      expect(await fs.readFile(pidPath, "utf8")).toBe("0\n");
      await Promise.resolve();
      expect(rollbackStarted).toBe(false);

      tunnelLive = false;
      harness.exit();
      await expect(publication).rejects.toThrow(/injected directory sync failure/i);
      expect(tunnelLive).toBe(false);
      expect(harness.kill).toHaveBeenCalledOnce();
      expect(await fs.readFile(artifactPath, "utf8")).toBe(oldArtifact);
      expect(await fs.readFile(pidPath, "utf8")).toBe(oldPid);
      expect(syncDirectory).toHaveBeenCalledWith(tempDir);
    } finally {
      harness.exit();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("closes and validates child stdin before service startup, then returns one ready response", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-host-child-"));
    setOracleHomeDirOverrideForTest(tempDir);
    const input = Readable.from([
      Buffer.from(credentialPayload({ legacyToken: LEGACY_TOKEN }), "utf8"),
    ]);
    const readinessWrites: Buffer[] = [];
    const readinessOutput = new Writable({
      write(chunk, _encoding, callback) {
        readinessWrites.push(Buffer.from(chunk as Uint8Array));
        callback();
      },
    });
    const serveRemote = vi.fn(
      async (options: RemoteServerOptions = {}, lifecycle: RemoteServerLifecycle = {}) => {
        expect(input.readableEnded).toBe(true);
        expect(options).toMatchObject({ token: MODERN_TOKEN, legacyToken: LEGACY_TOKEN });
        await lifecycle.onReady?.({ port: 9473, token: MODERN_TOKEN });
      },
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runBridgeHost(
        { backgroundChild: true, bind: "127.0.0.1:9473" },
        { stdin: input, readinessOutput, serveRemote },
      );
      expect(serveRemote).toHaveBeenCalledOnce();
      expect(Buffer.concat(readinessWrites).toString("utf8")).toBe(
        readinessPayload(READINESS_NONCE),
      );
      await expect(fs.access(path.join(tempDir, "bridge-connection.json"))).rejects.toThrow();
      expect(log.mock.calls.flat().join("\n")).not.toContain(MODERN_TOKEN);
      expect(log.mock.calls.flat().join("\n")).not.toContain(LEGACY_TOKEN);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects missing, oversized, malformed, and extra child bytes without echoing them", async () => {
    const valid = credentialPayload();
    const cases: Array<{ name: string; chunks: Buffer[]; expected: RegExp }> = [
      { name: "missing", chunks: [], expected: /payload is missing/i },
      {
        name: "oversized",
        chunks: [Buffer.alloc(BRIDGE_HOST_CREDENTIAL_PAYLOAD_MAX_BYTES + 1, 0x61)],
        expected: /exceeds the 512-byte limit/i,
      },
      {
        name: "malformed",
        chunks: [Buffer.from('{"DO_NOT_ECHO":"credential-marker"}\n', "utf8")],
        expected: /payload is malformed/i,
      },
      {
        name: "extra",
        chunks: [Buffer.from(`${valid}extra`, "utf8")],
        expected: /contains extra bytes/i,
      },
    ];

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const testCase of cases) {
      const serveRemote = vi.fn(async () => undefined);
      const failure = await runBridgeHost(
        { backgroundChild: true },
        { stdin: Readable.from(testCase.chunks), serveRemote },
      ).then(
        () => new Error(`${testCase.name} unexpectedly succeeded`),
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
      expect(failure.message).toMatch(testCase.expected);
      expect(failure.message).not.toContain("DO_NOT_ECHO");
      expect(failure.message).not.toContain("credential-marker");
      expect(serveRemote).not.toHaveBeenCalled();
    }
    expect(log.mock.calls.flat().join("\n")).not.toContain("credential-marker");
  });

  it.each([
    ["occupied listener", new Error("listen EADDRINUSE: address already in use")],
    ["occupied controller lock", new Error("Remote browser controller lock is already held")],
  ] as const)("preserves the foreground artifact on %s rejection", async (_name, startupError) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-host-occupied-"));
    const artifactPath = path.join(tempDir, "connection.json");
    const oldArtifact = '{"old":"foreground"}\n';
    await fs.writeFile(artifactPath, oldArtifact);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        runBridgeHost(
          { token: MODERN_TOKEN, writeConnection: artifactPath },
          {
            serveRemote: async () => {
              throw startupError;
            },
          },
        ),
      ).rejects.toThrow(startupError.message);
      expect(await fs.readFile(artifactPath, "utf8")).toBe(oldArtifact);
      expect(log.mock.calls.flat().join("\n")).not.toContain("Bridge host started");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves the foreground artifact when exact tunnel readiness rejects", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-host-tunnel-fail-"));
    const artifactPath = path.join(tempDir, "connection.json");
    const oldArtifact = '{"old":"foreground"}\n';
    await fs.writeFile(artifactPath, oldArtifact);
    const stop = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        runBridgeHost(
          {
            token: MODERN_TOKEN,
            writeConnection: artifactPath,
            ssh: "synthetic-host",
          },
          {
            serveRemote: async (options, lifecycle) => {
              const token = options?.token;
              if (!token) throw new Error("missing bridge credential");
              await lifecycle?.onReady?.({ port: 9473, token });
            },
            startReverseTunnel: () => ({
              ready: Promise.reject(new Error("remote forward denied")),
              stop,
            }),
          },
        ),
      ).rejects.toThrow(/remote forward denied/i);
      expect(stop).toHaveBeenCalledOnce();
      expect(await fs.readFile(artifactPath, "utf8")).toBe(oldArtifact);
      expect(log.mock.calls.flat().join("\n")).not.toContain("Bridge host started");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("treats a service that resolves before onReady as explicitly not started", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-bridge-host-no-ready-"));
    const artifactPath = path.join(tempDir, "connection.json");
    const oldArtifact = '{"old":true}\n';
    await fs.writeFile(artifactPath, oldArtifact);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        runBridgeHost(
          { token: MODERN_TOKEN, writeConnection: artifactPath },
          { serveRemote: async () => undefined },
        ),
      ).rejects.toThrow(/did not start.*before readiness/i);
      expect(await fs.readFile(artifactPath, "utf8")).toBe(oldArtifact);
      expect(log.mock.calls.flat().join("\n")).not.toContain("Bridge host started");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe.each([
  {
    name: "native Windows OpenSSH",
    platform: "win32" as const,
    expectSshArgs: expectNativeWindowsSshArgs,
  },
  {
    name: "POSIX OpenSSH control socket",
    platform: "linux" as const,
    expectSshArgs: expectPosixSshArgs,
  },
])("$name bridge tunnel contract", ({ name, platform, expectSshArgs }) => {
  it.each([
    { name: "foreground", backgroundChild: false },
    { name: "background child", backgroundChild: true },
  ])("gates $name readiness on authenticated remote-side health", async ({ backgroundChild }) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-ssh-bridge-ready-"));
    const artifactPath = path.join(tempDir, "connection.json");
    const oldArtifact = '{"old":"ssh"}\n';
    await fs.writeFile(artifactPath, oldArtifact);
    setOracleHomeDirOverrideForTest(tempDir);
    const healthRequested = Promise.withResolvers<void>();
    const releaseHealth = Promise.withResolvers<void>();
    const healthServer = http.createServer((req, res) => {
      healthRequested.resolve();
      void releaseHealth.promise.then(() => writeHealthResponse(req, res, MODERN_TOKEN));
    });
    const healthPort = await listenLoopback(healthServer);
    const harness = createFakeSshTunnelHarness(platform, healthPort);
    const readinessWrites: Buffer[] = [];
    const readinessOutput = new Writable({
      write(chunk, _encoding, callback) {
        readinessWrites.push(Buffer.from(chunk as Uint8Array));
        callback();
      },
    });
    const serveRemote = async (
      options: RemoteServerOptions = {},
      lifecycle: RemoteServerLifecycle = {},
    ) => {
      await lifecycle.onReady?.({ port: 9473, token: options.token! });
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const run = backgroundChild
        ? runBridgeHost(
            { backgroundChild: true, bind: "127.0.0.1:9473", ssh: "synthetic-host" },
            {
              stdin: Readable.from([credentialPayload()]),
              readinessOutput,
              serveRemote,
              tunnelPlatform: platform,
              tunnelSpawn: harness.tunnelSpawn,
            },
          )
        : runBridgeHost(
            {
              token: MODERN_TOKEN,
              bind: "127.0.0.1:9473",
              ssh: "synthetic-host",
              writeConnection: artifactPath,
            },
            { serveRemote, tunnelPlatform: platform, tunnelSpawn: harness.tunnelSpawn },
          );

      await Promise.race([
        healthRequested.promise,
        run.then(
          () => {
            throw new Error(`${name} tunnel published readiness without remote health`);
          },
          (error: unknown) => {
            throw error;
          },
        ),
      ]);
      if (backgroundChild) {
        expect(readinessWrites).toHaveLength(0);
      } else {
        expect(await fs.readFile(artifactPath, "utf8")).toBe(oldArtifact);
      }

      releaseHealth.resolve();
      await run;
      expectSshArgs(harness.sshArgs);
      expect(harness.mainChildren).toHaveLength(1);
      expect(harness.controlChildren).toHaveLength(platform === "win32" ? 0 : 2);
      expect(harness.probeChildren).toHaveLength(1);
      expect(harness.sshChildren).toHaveLength(platform === "win32" ? 2 : 4);
      for (const child of [...harness.mainChildren, ...harness.probeChildren]) {
        expect(child.kill).toHaveBeenCalledOnce();
      }
      for (const child of harness.controlChildren) expect(child.kill).not.toHaveBeenCalled();
      if (backgroundChild) {
        expect(Buffer.concat(readinessWrites).toString("utf8")).toBe(
          readinessPayload(READINESS_NONCE),
        );
      } else {
        expect(JSON.parse(await fs.readFile(artifactPath, "utf8"))).toMatchObject({
          remoteToken: MODERN_TOKEN,
        });
      }
      expect(log.mock.calls.flat().join("\n")).not.toContain(MODERN_TOKEN);
    } finally {
      releaseHealth.resolve();
      harness.mainChildren[0]?.exit(1);
      await closeServer(healthServer);
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    { name: "foreground", backgroundChild: false },
    { name: "background child", backgroundChild: true },
  ])(
    "fails $name readiness when remote-side health is not authenticated",
    async ({ backgroundChild }) => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-ssh-bridge-fail-"));
      const artifactPath = path.join(tempDir, "connection.json");
      const oldArtifact = '{"old":"ssh"}\n';
      await fs.writeFile(artifactPath, oldArtifact);
      setOracleHomeDirOverrideForTest(tempDir);
      const secondHealthRequest = Promise.withResolvers<void>();
      let healthRequestCount = 0;
      const healthServer = http.createServer((req, res) => {
        healthRequestCount += 1;
        writeHealthResponse(req, res, LEGACY_TOKEN);
        if (healthRequestCount === 2) secondHealthRequest.resolve();
      });
      const healthPort = await listenLoopback(healthServer);
      const harness = createFakeSshTunnelHarness(platform, healthPort);
      const readinessWrites: Buffer[] = [];
      const readinessOutput = new Writable({
        write(chunk, _encoding, callback) {
          readinessWrites.push(Buffer.from(chunk as Uint8Array));
          callback();
        },
      });
      const serveRemote = async (
        options: RemoteServerOptions = {},
        lifecycle: RemoteServerLifecycle = {},
      ) => {
        await lifecycle.onReady?.({ port: 9473, token: options.token! });
      };
      vi.spyOn(console, "log").mockImplementation(() => undefined);

      try {
        const run = backgroundChild
          ? runBridgeHost(
              { backgroundChild: true, bind: "127.0.0.1:9473", ssh: "synthetic-host" },
              {
                stdin: Readable.from([credentialPayload()]),
                readinessOutput,
                serveRemote,
                tunnelPlatform: platform,
                tunnelSpawn: harness.tunnelSpawn,
              },
            )
          : runBridgeHost(
              {
                token: MODERN_TOKEN,
                bind: "127.0.0.1:9473",
                ssh: "synthetic-host",
                writeConnection: artifactPath,
              },
              { serveRemote, tunnelPlatform: platform, tunnelSpawn: harness.tunnelSpawn },
            );
        const failure = run.then(
          () => new Error(`${name} tunnel unexpectedly became ready`),
          (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
        );

        await Promise.race([
          secondHealthRequest.promise,
          failure.then((error) => {
            throw error;
          }),
        ]);
        expectSshArgs(harness.sshArgs);
        if (backgroundChild) {
          expect(readinessWrites).toHaveLength(0);
        } else {
          expect(await fs.readFile(artifactPath, "utf8")).toBe(oldArtifact);
        }
        harness.mainChildren[0]?.exit(1);

        expect((await failure).message).toMatch(/failed before the remote forward was ready/i);
        expect(harness.mainChildren).toHaveLength(1);
        expect(harness.controlChildren).toHaveLength(platform === "win32" ? 0 : 2);
        expect(harness.probeChildren).toHaveLength(2);
        expect(harness.sshChildren).toHaveLength(platform === "win32" ? 3 : 5);
        expect(harness.mainChildren[0]!.kill).not.toHaveBeenCalled();
        for (const child of harness.probeChildren) expect(child.kill).toHaveBeenCalledOnce();
        for (const child of harness.controlChildren) expect(child.kill).not.toHaveBeenCalled();
        if (backgroundChild) {
          expect(Buffer.concat(readinessWrites).toString("utf8")).toBe(
            readinessPayload(READINESS_NONCE, "failed"),
          );
        } else {
          expect(await fs.readFile(artifactPath, "utf8")).toBe(oldArtifact);
        }
      } finally {
        harness.mainChildren[0]?.exit(1);
        await closeServer(healthServer);
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});

describe("reverse tunnel shutdown drain", () => {
  it("keeps stop pending until the live SSH child exits", async () => {
    const healthServer = http.createServer((req, res) =>
      writeHealthResponse(req, res, MODERN_TOKEN),
    );
    const healthPort = await listenLoopback(healthServer);
    const harness = createFakeSshTunnelHarness("win32", healthPort);
    const tunnel = startReverseTunnel({
      sshTarget: "synthetic-host",
      remotePort: 9473,
      localPort: 9473,
      token: MODERN_TOKEN,
      log: () => undefined,
      platform: "win32",
      spawnSsh: harness.tunnelSpawn,
      shutdownTimeoutMs: 1_000,
    });

    try {
      await tunnel.ready;
      const master = harness.mainChildren[0]!;
      master.kill.mockImplementation(() => true);
      const settled = vi.fn();
      const stop = Promise.resolve(tunnel.stop()).then(settled);

      await Promise.resolve();
      expect(master.kill).toHaveBeenCalledWith("SIGTERM");
      expect(settled).not.toHaveBeenCalled();

      master.exit(0);
      await stop;
      expect(settled).toHaveBeenCalledOnce();
    } finally {
      harness.mainChildren[0]?.exit(0);
      await Promise.resolve(tunnel.stop()).catch(() => undefined);
      await closeServer(healthServer);
    }
  });

  it("force-kills an SSH child that misses the graceful shutdown deadline", async () => {
    const healthServer = http.createServer((req, res) =>
      writeHealthResponse(req, res, MODERN_TOKEN),
    );
    const healthPort = await listenLoopback(healthServer);
    const harness = createFakeSshTunnelHarness("win32", healthPort);
    const tunnel = startReverseTunnel({
      sshTarget: "synthetic-host",
      remotePort: 9473,
      localPort: 9473,
      token: MODERN_TOKEN,
      log: () => undefined,
      platform: "win32",
      spawnSsh: harness.tunnelSpawn,
      shutdownTimeoutMs: 5,
    });

    try {
      await tunnel.ready;
      const master = harness.mainChildren[0]!;
      master.kill.mockImplementation((signal?: NodeJS.Signals | number) => {
        if (signal === "SIGKILL") master.exit(0);
        return true;
      });

      await tunnel.stop();
      expect(master.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    } finally {
      harness.mainChildren[0]?.exit(0);
      await Promise.resolve(tunnel.stop()).catch(() => undefined);
      await closeServer(healthServer);
    }
  });
});

describe("native Windows OpenSSH bridge tunnel contract", () => {
  it("rejects Windows control-socket options before spawning SSH", async () => {
    const tunnelSpawn = vi.fn();
    await expect(
      runBridgeHost(
        {
          token: MODERN_TOKEN,
          ssh: "synthetic-host",
          sshExtraArgs: "-o ControlPath=forbidden",
        },
        {
          serveRemote: async (options, lifecycle) => {
            const token = options?.token;
            if (!token) throw new Error("missing bridge credential");
            await lifecycle?.onReady?.({ port: 9473, token });
          },
          tunnelPlatform: "win32",
          tunnelSpawn,
        },
      ),
    ).rejects.toThrow(/Native Windows OpenSSH.*ControlPath/i);
    expect(tunnelSpawn).not.toHaveBeenCalled();
  });
});
