import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import {
  formatBridgeConnectionString,
  normalizeHostPort,
  parseHostPort,
} from "../../bridge/connection.js";
import type { BridgeConnectionArtifact } from "../../bridge/connection.js";
import { getOracleHomeDir } from "../../oracleHome.js";
import { assertRemoteCredential, generateRemoteCredential } from "../../remote/auth.js";
import { assertLoopbackRemoteBind } from "../../remote/remoteServiceConfig.js";
import { serveRemote } from "../../remote/server.js";
import {
  BRIDGE_HOST_READINESS_TIMEOUT_MS,
  WINDOWS_BRIDGE_CHILD_READINESS_STDOUT,
  publishReadyBridgeConnection,
  readBridgeHostCredentialPayload,
  spawnReadyBridgeHostChildAndPublish,
  writeBridgeHostReadinessPayload,
} from "./childProtocol.js";
import type { BridgeHostCredentials, BridgeHostSpawn } from "./childProtocol.js";
import { startReverseTunnel } from "./reverseTunnel.js";
import type { ReverseTunnelHandle, StartReverseTunnel } from "./reverseTunnel.js";

export {
  BRIDGE_HOST_CREDENTIAL_PAYLOAD_MAX_BYTES,
  BRIDGE_HOST_READINESS_PAYLOAD_MAX_BYTES,
  BRIDGE_HOST_READINESS_TIMEOUT_MS,
} from "./childProtocol.js";

export interface BridgeHostCliOptions {
  bind?: string;
  token?: string;
  legacyToken?: string;
  writeConnection?: string;
  ssh?: string;
  sshRemotePort?: number;
  sshIdentity?: string;
  sshExtraArgs?: string;
  background?: boolean;
  backgroundChild?: boolean;
  foreground?: boolean;
  print?: boolean;
  printToken?: boolean;
}

export interface BridgeHostDeps {
  serveRemote?: typeof serveRemote;
  startReverseTunnel?: StartReverseTunnel;
  spawn?: BridgeHostSpawn;
  stdin?: NodeJS.ReadableStream;
  readinessOutput?: NodeJS.WritableStream;
  env?: NodeJS.ProcessEnv;
  generateReadinessNonce?: () => string;
  readinessTimeoutMs?: number;
  backgroundPlatform?: NodeJS.Platform;
  tunnelPlatform?: NodeJS.Platform;
  tunnelSpawn?: BridgeHostSpawn;
}

export async function runBridgeHost(
  options: BridgeHostCliOptions,
  deps: BridgeHostDeps = {},
): Promise<void> {
  const runtimeEnv = deps.env ?? process.env;
  const bindRaw = options.bind?.trim() || "127.0.0.1:9473";
  const { hostname: bindHost, port: bindPort } = parseHostPort(bindRaw);
  assertLoopbackRemoteBind(bindHost);

  if (
    options.backgroundChild &&
    (options.background ||
      options.foreground ||
      options.token !== undefined ||
      options.legacyToken !== undefined ||
      options.writeConnection !== undefined ||
      options.print ||
      options.printToken)
  ) {
    throw new Error("Bridge host background child mode received conflicting CLI options.");
  }

  let credentials: BridgeHostCredentials;
  let childReadinessNonce: string | undefined;
  if (options.backgroundChild) {
    const payload = await readBridgeHostCredentialPayload(deps.stdin ?? process.stdin);
    credentials = payload;
    childReadinessNonce = payload.readinessNonce;
  } else {
    const tokenRaw = options.token ?? "auto";
    credentials = {
      token:
        tokenRaw === "auto"
          ? generateRemoteCredential()
          : assertRemoteCredential(tokenRaw, "Bridge host --token"),
      legacyToken:
        options.legacyToken === undefined
          ? undefined
          : assertRemoteCredential(options.legacyToken, "Bridge host --legacy-token"),
    };
  }
  if (credentials.legacyToken && credentials.legacyToken === credentials.token) {
    throw new Error(
      "Legacy text clients require a bearer credential distinct from the modern v3 HMAC root key.",
    );
  }

  const writeConnectionPath =
    options.writeConnection?.trim() || path.join(getOracleHomeDir(), "bridge-connection.json");
  const sshTarget = options.ssh?.trim();
  const sshRemotePort =
    typeof options.sshRemotePort === "number" ? options.sshRemotePort : bindPort;
  if (sshRemotePort <= 0 || sshRemotePort > 65_535) {
    throw new Error(`Invalid --ssh-remote-port: ${sshRemotePort}. Expected 1-65535.`);
  }

  const connectionInput: Pick<BridgeConnectionArtifact, "remoteHost" | "remoteToken" | "tunnel"> = {
    remoteHost: sshTarget
      ? normalizeHostPort("127.0.0.1", sshRemotePort)
      : normalizeHostPort(bindHost, bindPort),
    remoteToken: credentials.token,
    tunnel: sshTarget
      ? {
          ssh: sshTarget,
          remotePort: sshRemotePort,
          localPort: bindPort,
          identity: options.sshIdentity?.trim() || undefined,
          extraArgs: options.sshExtraArgs?.trim() || undefined,
        }
      : undefined,
  };

  if (options.background) {
    const spawnChild: BridgeHostSpawn =
      deps.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    const result = await spawnReadyBridgeHostChildAndPublish(
      {
        bind: bindRaw,
        credentials,
        connectionInput,
        writeConnectionPath,
        sshTarget,
        sshRemotePort,
        sshIdentity: options.sshIdentity?.trim(),
        sshExtraArgs: options.sshExtraArgs?.trim(),
      },
      {
        spawnChild,
        parentEnv: runtimeEnv,
        readinessNonce: (deps.generateReadinessNonce ?? randomUUID)(),
        readinessTimeoutMs: deps.readinessTimeoutMs ?? BRIDGE_HOST_READINESS_TIMEOUT_MS,
        platform: deps.backgroundPlatform,
      },
    );
    console.log(chalk.green(`Bridge host running in background (pid ${result.pid})`));
    console.log(chalk.dim(`- Log: ${result.logPath}`));
    console.log(chalk.dim(`- PID: ${result.pidPath}`));
    printRequestedConnection(options, result.artifact, credentials.token);
    return;
  }

  const startTunnel = deps.startReverseTunnel ?? startReverseTunnel;
  const runRemoteService = deps.serveRemote ?? serveRemote;
  const readinessUsesStdout =
    options.backgroundChild && runtimeEnv[WINDOWS_BRIDGE_CHILD_READINESS_STDOUT] === "1";
  const bridgeLog = readinessUsesStdout ? console.error : console.log;
  const readinessOutput = options.backgroundChild
    ? (deps.readinessOutput ??
      (readinessUsesStdout ? process.stdout : createWriteStream("", { fd: 3, autoClose: true })))
    : undefined;
  const tunnelHandle: { current: ReverseTunnelHandle | null } = { current: null };
  let ready = false;
  try {
    await runRemoteService(
      {
        host: bindHost,
        port: bindPort,
        token: credentials.token,
        legacyToken: credentials.legacyToken,
        logger: bridgeLog,
      },
      {
        onReady: async (server) => {
          if (server.port !== bindPort || server.token !== credentials.token) {
            throw new Error(
              "Bridge host remote service readiness did not match the requested bind.",
            );
          }
          if (sshTarget) {
            tunnelHandle.current = await startTunnel({
              sshTarget,
              remotePort: sshRemotePort,
              localPort: bindPort,
              token: credentials.token,
              identity: options.sshIdentity?.trim() || undefined,
              extraArgs: options.sshExtraArgs?.trim() || undefined,
              log: (message) => bridgeLog(chalk.dim(message)),
              platform: deps.tunnelPlatform,
              spawnSsh: deps.tunnelSpawn,
            });
            await tunnelHandle.current.ready;
          }

          if (options.backgroundChild) {
            await writeBridgeHostReadinessPayload(readinessOutput!, {
              readinessNonce: childReadinessNonce!,
              status: "ready",
            });
          } else {
            await publishReadyBridgeConnection(writeConnectionPath, connectionInput, (artifact) =>
              printForegroundReady({
                options,
                artifact,
                writeConnectionPath,
                bindHost,
                bindPort,
                sshTarget,
                sshRemotePort,
                legacyToken: credentials.legacyToken,
                token: credentials.token,
              }),
            );
          }
          ready = true;
        },
      },
    );
    if (!ready) {
      throw new Error("Bridge host did not start: remote service exited before readiness.");
    }
  } catch (error) {
    if (options.backgroundChild && !ready && childReadinessNonce && readinessOutput) {
      await writeBridgeHostReadinessPayload(readinessOutput, {
        readinessNonce: childReadinessNonce,
        status: "failed",
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await tunnelHandle.current?.stop();
  }
}

function printRequestedConnection(
  options: BridgeHostCliOptions,
  artifact: BridgeConnectionArtifact,
  token: string,
): void {
  if (options.printToken) console.log(token);
  if (options.print) {
    console.log(
      formatBridgeConnectionString(
        { remoteHost: artifact.remoteHost, remoteToken: token },
        { includeToken: true },
      ),
    );
  }
}

function printForegroundReady(params: {
  options: BridgeHostCliOptions;
  artifact: BridgeConnectionArtifact;
  writeConnectionPath: string;
  bindHost: string;
  bindPort: number;
  sshTarget?: string;
  sshRemotePort: number;
  legacyToken?: string;
  token: string;
}): void {
  console.log(chalk.cyanBright("Bridge host started."));
  console.log(chalk.dim(`- Local bind: ${normalizeHostPort(params.bindHost, params.bindPort)}`));
  console.log(chalk.dim(`- Connection artifact: ${params.writeConnectionPath}`));
  console.log(chalk.dim(`- Client remoteHost: ${params.artifact.remoteHost}`));
  console.log(
    chalk.dim(
      "Token stored in connection artifact (not printed). Use --print or --print-token if needed.",
    ),
  );
  if (params.legacyToken) {
    console.log(chalk.dim("- Predecessor text compatibility: enabled with a distinct bearer"));
  }
  if (params.sshTarget) {
    console.log(
      chalk.dim(
        `Reverse SSH tunnel active (remote 127.0.0.1:${params.sshRemotePort} -> local 127.0.0.1:${params.bindPort})`,
      ),
    );
  }
  printRequestedConnection(params.options, params.artifact, params.token);
}
