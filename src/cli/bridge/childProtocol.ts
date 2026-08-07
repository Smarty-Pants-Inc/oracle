import type { ChildProcess, SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { BridgeConnectionArtifact } from "../../bridge/connection.js";
import { getOracleHomeDir } from "../../oracleHome.js";
import { writeFileAtomicDurable } from "../../sessionManager.js";
import type { WindowsPrivateFileAuthority } from "../../windowsPrivateFileAcl.js";
import {
  BridgeArtifactPublicationError,
  captureFileSnapshot,
  capturePublishedFile,
  type ConnectionInput,
  type BridgeConnectionPublication,
  type PublishedFile,
  preflightBridgeConnectionArtifactPath,
  restoreFileSnapshots,
  upsertConnectionArtifact,
} from "./connectionArtifact.js";
import {
  assertReadinessNonce,
  bridgeHostChildExited,
  buildBridgeHostBackgroundEnvironment,
  type BridgeHostCredentialPayload,
  type BridgeHostCredentials,
  encodeBridgeHostCredentialPayload,
  terminateBridgeHostChildTree,
  type UnrefReadable,
  type UnrefWritable,
  waitForBridgeHostReadiness,
  writeOneShotBridgeHostLine,
} from "./childIpc.js";
import { buildWindowsBridgeSupervisorLaunch } from "./windowsSupervisor.js";

export {
  BRIDGE_HOST_CREDENTIAL_PAYLOAD_MAX_BYTES,
  BRIDGE_HOST_READINESS_PAYLOAD_MAX_BYTES,
  BRIDGE_HOST_READINESS_TIMEOUT_MS,
  readBridgeHostCredentialPayload,
  writeBridgeHostReadinessPayload,
} from "./childIpc.js";
export type { BridgeHostCredentials } from "./childIpc.js";
export {
  preflightBridgeConnectionArtifactPath,
  publishReadyBridgeConnection,
  resolveBridgeConnectionArtifactPath,
} from "./connectionArtifact.js";
export { WINDOWS_BRIDGE_CHILD_READINESS_STDOUT } from "./windowsSupervisor.js";

export interface BridgeHostSpawnResult {
  artifact: BridgeConnectionArtifact;
  logPath: string;
  pidPath: string;
  pid: number;
}

export type BridgeHostSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export async function spawnReadyBridgeHostChildAndPublish(
  {
    bind,
    credentials,
    connectionInput,
    writeConnectionPath,
    sshTarget,
    sshRemotePort,
    sshIdentity,
    sshExtraArgs,
  }: {
    bind: string;
    credentials: BridgeHostCredentials;
    connectionInput: ConnectionInput;
    writeConnectionPath: string;
    sshTarget?: string;
    sshRemotePort?: number;
    sshIdentity?: string;
    sshExtraArgs?: string;
  },
  deps: {
    spawnChild: BridgeHostSpawn;
    parentEnv: NodeJS.ProcessEnv;
    readinessNonce: string;
    readinessTimeoutMs: number;
    platform?: NodeJS.Platform;
    windowsPrivateFileAuthority?: WindowsPrivateFileAuthority;
  },
): Promise<BridgeHostSpawnResult> {
  const platform = deps.platform ?? process.platform;
  const oracleHome = getOracleHomeDir();
  const logPath = path.join(oracleHome, "bridge-host.log");
  const pidPath = path.join(oracleHome, "bridge-host.pid");
  if (
    path.resolve(writeConnectionPath) === path.resolve(pidPath) ||
    path.resolve(writeConnectionPath) === path.resolve(logPath)
  ) {
    throw new Error("Bridge host connection artifact path conflicts with a background state file.");
  }
  await preflightBridgeConnectionArtifactPath(writeConnectionPath);
  await fs.mkdir(oracleHome, { recursive: true, mode: 0o700 });

  const payload: BridgeHostCredentialPayload = {
    readinessNonce: assertReadinessNonce(
      deps.readinessNonce,
      "Bridge host background readiness nonce",
    ),
    ...credentials,
  };
  const encodedPayload = encodeBridgeHostCredentialPayload(payload);
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Unable to determine CLI entrypoint for background mode.");
  }
  const args: string[] = [scriptPath, "bridge", "host", "--background-child", "--bind", bind];
  if (sshTarget) {
    args.push("--ssh", sshTarget);
    if (typeof sshRemotePort === "number") {
      args.push("--ssh-remote-port", String(sshRemotePort));
    }
    if (sshIdentity) args.push("--ssh-identity", sshIdentity);
    if (sshExtraArgs) args.push("--ssh-extra-args", sshExtraArgs);
  }

  const protectedValues = [payload.token, payload.legacyToken, payload.readinessNonce].filter(
    (value): value is string => value !== undefined,
  );
  const parentEnv = buildBridgeHostBackgroundEnvironment(deps.parentEnv, payload);
  const launch =
    platform === "win32"
      ? buildWindowsBridgeSupervisorLaunch(args, parentEnv)
      : { command: process.execPath, args, env: parentEnv };
  if (
    [launch.command, ...launch.args, ...Object.values(launch.env)].some(
      (value) =>
        value !== undefined &&
        protectedValues.some((protectedValue) => value.includes(protectedValue)),
    )
  ) {
    throw new Error("Bridge host background options contain protected IPC material.");
  }

  const logHandle = await fs.open(logPath, "a");
  let child: ChildProcess | undefined;
  let publicationCleanupHandled = false;
  try {
    child = deps.spawnChild(launch.command, launch.args, {
      detached: true,
      stdio:
        platform === "win32"
          ? ["pipe", "pipe", logHandle.fd]
          : ["pipe", logHandle.fd, logHandle.fd, "pipe"],
      env: launch.env,
      windowsHide: true,
    });
    const readinessInput = (platform === "win32" ? child.stdout : child.stdio[3]) as
      | UnrefReadable
      | null
      | undefined;
    if (!child.stdin || !readinessInput || child.pid === undefined) {
      throw new Error(
        "Bridge host background child started without the required pipes or process ID.",
      );
    }
    const childPid = child.pid;
    child.unref();
    await Promise.all([
      writeOneShotBridgeHostLine(
        child.stdin as UnrefWritable,
        encodedPayload,
        "Bridge host credential",
      ),
      waitForBridgeHostReadiness({
        child,
        stream: readinessInput,
        readinessNonce: payload.readinessNonce,
        timeoutMs: deps.readinessTimeoutMs,
      }),
    ]);

    const [pidSnapshot, artifactSnapshot] = await Promise.all([
      captureFileSnapshot(pidPath),
      captureFileSnapshot(writeConnectionPath),
    ]);
    let pidPublishedFile: PublishedFile | undefined;
    let artifactPublication: BridgeConnectionPublication | undefined;
    let childExited = false;
    const markChildExited = () => {
      childExited = true;
    };
    const assertChildRunning = () => {
      if (childExited || bridgeHostChildExited(child!)) {
        throw new Error("Bridge host background child exited during state publication.");
      }
    };
    child.once("error", markChildExited);
    child.once("exit", markChildExited);
    try {
      assertChildRunning();
      await writeFileAtomicDurable(pidPath, `${childPid}\n`);
      pidPublishedFile = await capturePublishedFile(pidPath);
      assertChildRunning();
      artifactPublication = await upsertConnectionArtifact(
        writeConnectionPath,
        connectionInput,
        {
          platform,
          windowsPrivateFileAuthority: deps.windowsPrivateFileAuthority,
          deferFailureCleanup: true,
        },
        artifactSnapshot,
      );
      assertChildRunning();
      child.off("error", markChildExited);
      child.off("exit", markChildExited);
      return { artifact: artifactPublication.artifact, logPath, pidPath, pid: childPid };
    } catch (error) {
      const failedArtifactPublishedFile =
        error instanceof BridgeArtifactPublicationError ? error.publishedFile : undefined;
      publicationCleanupHandled = true;
      try {
        // Drain the ready child tree before rolling published state back.
        await terminateBridgeHostChildTree(child, platform);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Bridge host background state publication failed before the child tree could be drained.",
        );
      }
      try {
        const artifactPublishedFile =
          artifactPublication?.publishedFile ?? failedArtifactPublishedFile;
        await restoreFileSnapshots([
          ...(artifactPublishedFile
            ? [
                {
                  filePath: writeConnectionPath,
                  snapshot: artifactSnapshot,
                  expectedPublishedFile: artifactPublishedFile,
                  privacy: {
                    platform,
                    windowsPrivateFileAuthority: deps.windowsPrivateFileAuthority,
                  },
                },
              ]
            : []),
          ...(pidPublishedFile
            ? [
                {
                  filePath: pidPath,
                  snapshot: pidSnapshot,
                  expectedPublishedFile: pidPublishedFile,
                },
              ]
            : []),
        ]);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Bridge host background state publication failed after the child tree was drained, but rollback failed.",
        );
      }
      throw error;
    } finally {
      child.off("error", markChildExited);
      child.off("exit", markChildExited);
    }
  } catch (error) {
    if (child && !publicationCleanupHandled) await terminateBridgeHostChildTree(child, platform);
    throw error;
  } finally {
    await logHandle.close().catch(() => undefined);
  }
}
