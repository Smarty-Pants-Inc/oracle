import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, readFile, readdir, rmdir, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import {
  physicalDirectoryIdentityFromStats,
  samePhysicalDirectoryIdentity,
} from "./filesystemLockDirectoryIdentity.js";
import type { PhysicalDirectoryIdentity } from "./filesystemLockDirectoryIdentity.js";
import {
  encodeDirectoryRemovalMessage,
  parseDirectoryRemovalMessage,
} from "./filesystemLockDirectoryRemovalProtocol.js";
import type { DirectoryRemovalMessage } from "./filesystemLockDirectoryRemovalProtocol.js";

const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : null;
const hasDirectoryCapabilityFlags =
  Number.isInteger(constants.O_RDONLY) &&
  Number.isInteger(constants.O_DIRECTORY) &&
  Number.isInteger(constants.O_NOFOLLOW);
const directoryOpenFlags = hasDirectoryCapabilityFlags
  ? constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  : 0;

function descriptorPath(handle: FileHandle | undefined): string {
  if (descriptorRoot === null || handle === undefined) {
    throw new Error("Bound removal has no descriptor-rooted directory API on this platform");
  }
  return `${descriptorRoot}/${handle.fd}`;
}

function descriptorTraversalPath(handle: FileHandle | undefined): string {
  if (process.platform !== "linux") {
    throw new Error("Bound removal has no traversable descriptor path on this platform");
  }
  return descriptorPath(handle);
}

function assertSameDevice(entry: BigIntStats, expectedDevice: string, entryPath: string): void {
  const observedDevice = entry.dev.toString();
  if (expectedDevice === "0" || observedDevice === "0") {
    throw new Error(`Bound removal cannot prove the filesystem boundary at ${entryPath}`);
  }
  if (observedDevice !== expectedDevice) {
    throw new Error(`Bound removal refused to cross a filesystem boundary at ${entryPath}`);
  }
}

async function readMountId(handle: FileHandle | undefined): Promise<string | null> {
  if (process.platform !== "linux") return null;
  if (handle === undefined) {
    throw new Error("Bound removal cannot prove the Linux mount generation");
  }
  const raw = await readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8");
  const match = raw.match(/^mnt_id:\s+(\d+)$/m);
  if (!match) throw new Error("Bound removal cannot prove the Linux mount generation");
  return match[1]!;
}

function writeMessage(message: DirectoryRemovalMessage): Promise<void> {
  const deferred = Promise.withResolvers<void>();
  process.stdout.write(encodeDirectoryRemovalMessage(message), (error) => {
    if (error) deferred.reject(error);
    else deferred.resolve();
  });
  return deferred.promise;
}

async function readGo(token: string): Promise<void> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += String(chunk);
    const newline = input.indexOf("\n");
    if (newline < 0) continue;
    const message = parseDirectoryRemovalMessage(input.slice(0, newline));
    if (message.type !== "go" || message.token !== token) {
      throw new Error("Bound removal worker received an invalid go signal");
    }
    process.stdin.destroy();
    return;
  }
  throw new Error("Bound removal worker exited without an explicit go signal");
}

// Darwin fdesc paths are non-traversable, while Windows exposes no safe directory-open flags.
// A recursively spawned worker binds each directory as its cwd, attests that exact generation,
// and waits for go before mutating it.
async function runBoundCwdDirectoryChild(
  entryPath: string,
  expectedIdentity: PhysicalDirectoryIdentity,
  expectedDevice: string,
): Promise<void> {
  const token = randomUUID();
  const workerPath = process.argv[1];
  if (workerPath === undefined) throw new Error("Bound removal worker path is missing");
  const child = spawn(process.execPath, [...process.execArgv, workerPath, token, "directory"], {
    cwd: entryPath,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let childError: Error | undefined;
  let stderr = "";
  let stderrTruncated = false;
  const childClosed = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  child.once("close", (code, signal) => childClosed.resolve({ code, signal }));
  child.once("error", (error) => {
    childError = error;
  });
  child.stdin.on("error", () => undefined);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const remaining = 16_384 - stderr.length;
    if (remaining > 0) stderr += chunk.slice(0, remaining);
    if (chunk.length > remaining) stderrTruncated = true;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let exit: { code: number | null; signal: NodeJS.Signals | null } | null | undefined;
  const describeExit = async (): Promise<string> => {
    exit ??= await Promise.race([childClosed.promise, delay(1_000).then(() => null)]);
    const details: string[] = [];
    if (childError !== undefined) details.push(childError.message);
    if (stderr.trim()) {
      details.push(`${stderr.trim()}${stderrTruncated ? " [stderr truncated]" : ""}`);
    }
    if (exit !== null) {
      details.push(`exit ${String(exit.code)} signal ${String(exit.signal)}`);
    } else {
      details.push("stdout closed while child remained running");
    }
    return details.join("; ");
  };
  const readLine = async (): Promise<string> => {
    const result = await iterator.next();
    if (result.done) {
      throw new Error(
        `Bound removal directory child closed stdout before completing its protocol: ${await describeExit()}`,
      );
    }
    return result.value;
  };

  try {
    const attestation = parseDirectoryRemovalMessage(await readLine());
    if (
      attestation.type !== "attested-directory" ||
      attestation.token !== token ||
      !samePhysicalDirectoryIdentity(attestation.directoryIdentity, expectedIdentity) ||
      attestation.directoryIdentity.device !== expectedDevice
    ) {
      throw new Error("Bound removal directory child attested the wrong generation");
    }
    const completionLinePromise = readLine();
    child.stdin.end(encodeDirectoryRemovalMessage({ type: "go", token }));
    const completion = parseDirectoryRemovalMessage(await completionLinePromise);
    if (completion.type !== "completed" || completion.token !== token) {
      throw new Error("Bound removal directory child returned an invalid completion");
    }
    exit = await childClosed.promise;
    if (childError !== undefined || exit.code !== 0) {
      throw new Error(`Bound removal directory child failed: ${await describeExit()}`);
    }
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([childClosed.promise, delay(1_000)]);
    }
    throw error;
  } finally {
    lines.close();
  }
}

async function deleteBoundDirectoryContents(
  directoryHandle: FileHandle | undefined,
  expectedIdentity: PhysicalDirectoryIdentity,
  expectedMountId: string | null,
): Promise<void> {
  const directoryEntry =
    process.platform === "win32"
      ? await lstat(".", { bigint: true })
      : await directoryHandle!.stat({ bigint: true });
  if (
    !samePhysicalDirectoryIdentity(
      physicalDirectoryIdentityFromStats(directoryEntry),
      expectedIdentity,
    )
  ) {
    throw new Error("Bound removal directory generation changed before traversal");
  }
  assertSameDevice(directoryEntry, expectedIdentity.device, ".");
  const directoryPath =
    process.platform === "linux" ? descriptorTraversalPath(directoryHandle) : ".";
  for (const name of await readdir(directoryPath)) {
    const entryPath = path.join(directoryPath, name);
    const before = await lstat(entryPath, { bigint: true });
    if (before.isSymbolicLink()) {
      await unlink(entryPath);
      continue;
    }
    assertSameDevice(before, expectedIdentity.device, entryPath);
    if (!before.isDirectory()) {
      const current = await lstat(entryPath, { bigint: true });
      if (
        !samePhysicalDirectoryIdentity(
          physicalDirectoryIdentityFromStats(before),
          physicalDirectoryIdentityFromStats(current),
        )
      ) {
        throw new Error(`Bound removal file generation changed at ${entryPath}`);
      }
      await unlink(entryPath);
      continue;
    }

    let childHandle: FileHandle | undefined;
    try {
      let childEntry: BigIntStats;
      if (process.platform === "win32") {
        childEntry = await lstat(entryPath, { bigint: true });
      } else {
        childHandle = await open(entryPath, directoryOpenFlags);
        childEntry = await childHandle.stat({ bigint: true });
      }
      if (
        !childEntry.isDirectory() ||
        !samePhysicalDirectoryIdentity(
          physicalDirectoryIdentityFromStats(before),
          physicalDirectoryIdentityFromStats(childEntry),
        )
      ) {
        throw new Error(`Bound removal directory generation changed at ${entryPath}`);
      }
      const childIdentity = physicalDirectoryIdentityFromStats(childEntry);
      assertSameDevice(childEntry, expectedIdentity.device, entryPath);
      const childMountId = await readMountId(childHandle);
      if (expectedMountId !== null && childMountId !== expectedMountId) {
        throw new Error(`Bound removal refused to cross a mount boundary at ${entryPath}`);
      }
      if (process.platform === "linux") {
        await deleteBoundDirectoryContents(childHandle, childIdentity, expectedMountId);
      } else {
        await runBoundCwdDirectoryChild(entryPath, childIdentity, expectedIdentity.device);
      }
    } finally {
      await childHandle?.close();
    }

    const current = await lstat(entryPath, { bigint: true });
    if (
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(before),
        physicalDirectoryIdentityFromStats(current),
      )
    ) {
      throw new Error(`Bound removal directory generation changed before removal at ${entryPath}`);
    }
    await rmdir(entryPath);
  }
}

async function runDirectoryWorker(token: string): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error("Bound removal cwd worker is unavailable on this platform");
  }
  let directoryHandle: FileHandle | undefined;
  try {
    const pathEntry = await lstat(".", { bigint: true });
    let directoryEntry = pathEntry;
    if (process.platform !== "win32") {
      directoryHandle = await open(".", directoryOpenFlags);
      directoryEntry = await directoryHandle.stat({ bigint: true });
    }
    if (
      !directoryEntry.isDirectory() ||
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(pathEntry),
        physicalDirectoryIdentityFromStats(directoryEntry),
      )
    ) {
      throw new Error("Bound removal directory generation changed while opening capability");
    }
    await readdir(".");
    assertSameDevice(directoryEntry, directoryEntry.dev.toString(), ".");
    const directoryIdentity = physicalDirectoryIdentityFromStats(directoryEntry);
    await writeMessage({
      type: "attested-directory",
      token,
      directoryIdentity,
      mountId: null,
    });
    await readGo(token);

    const currentPathEntry = await lstat(".", { bigint: true });
    const currentEntry =
      process.platform === "win32"
        ? currentPathEntry
        : await directoryHandle!.stat({ bigint: true });
    if (
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(currentPathEntry),
        directoryIdentity,
      ) ||
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(currentEntry),
        directoryIdentity,
      )
    ) {
      throw new Error("Bound removal directory generation changed after attestation");
    }
    await deleteBoundDirectoryContents(directoryHandle, directoryIdentity, null);
    await writeMessage({ type: "completed", token });
  } finally {
    await directoryHandle?.close();
  }
}

async function runRootWorker(token: string): Promise<void> {
  const entries = await readdir(".");
  if (entries.length !== 1 || entries[0] !== "generation") {
    throw new Error("Bound removal root does not contain exactly one generation");
  }

  let rootHandle: FileHandle | undefined;
  let generationHandle: FileHandle | undefined;
  try {
    const rootPathEntry = await lstat(".", { bigint: true });
    const generationPathEntry = await lstat("generation", { bigint: true });
    let rootEntry = rootPathEntry;
    let generationEntry = generationPathEntry;
    if (process.platform !== "win32") {
      rootHandle = await open(".", directoryOpenFlags);
      generationHandle = await open("generation", directoryOpenFlags);
      rootEntry = await rootHandle.stat({ bigint: true });
      generationEntry = await generationHandle.stat({ bigint: true });
    }
    try {
      if (process.platform === "linux") {
        const rootedRootEntry = await stat(descriptorPath(rootHandle), { bigint: true });
        const rootedGenerationEntry = await stat(descriptorPath(generationHandle), {
          bigint: true,
        });
        if (
          !samePhysicalDirectoryIdentity(
            physicalDirectoryIdentityFromStats(rootedRootEntry),
            physicalDirectoryIdentityFromStats(rootEntry),
          ) ||
          !samePhysicalDirectoryIdentity(
            physicalDirectoryIdentityFromStats(rootedGenerationEntry),
            physicalDirectoryIdentityFromStats(generationEntry),
          )
        ) {
          throw new Error("descriptor paths resolved to different generations");
        }
        await readdir(descriptorTraversalPath(rootHandle));
        await readdir(descriptorTraversalPath(generationHandle));
      } else {
        await readdir(".");
        await readdir("generation");
      }
    } catch (error) {
      const detail =
        error instanceof Error
          ? `${
              typeof (error as NodeJS.ErrnoException).code === "string"
                ? `${(error as NodeJS.ErrnoException).code}: `
                : ""
            }${error.message}`
          : String(error);
      throw new Error(`Bound removal held-directory capability is unavailable: ${detail}`, {
        cause: error,
      });
    }
    if (
      !rootEntry.isDirectory() ||
      !generationEntry.isDirectory() ||
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(rootPathEntry),
        physicalDirectoryIdentityFromStats(rootEntry),
      ) ||
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(generationPathEntry),
        physicalDirectoryIdentityFromStats(generationEntry),
      )
    ) {
      throw new Error("Bound removal generation changed while opening directory capabilities");
    }
    assertSameDevice(rootEntry, rootEntry.dev.toString(), ".");
    assertSameDevice(generationEntry, rootEntry.dev.toString(), "generation");
    const rootMountId = await readMountId(rootHandle);
    const generationMountId = await readMountId(generationHandle);
    if (rootMountId !== null && generationMountId !== rootMountId) {
      throw new Error("Bound removal generation crosses a mount boundary");
    }

    const rootIdentity = physicalDirectoryIdentityFromStats(rootEntry);
    const generationIdentity = physicalDirectoryIdentityFromStats(generationEntry);
    await writeMessage({
      type: "attested",
      token,
      rootIdentity,
      generationIdentity,
    });
    await readGo(token);

    const rootTraversalPath =
      process.platform === "linux" ? descriptorTraversalPath(rootHandle) : ".";
    const currentEntries = await readdir(rootTraversalPath);
    if (currentEntries.length !== 1 || currentEntries[0] !== "generation") {
      throw new Error("Bound removal root changed after attestation");
    }
    const currentRoot =
      process.platform === "win32"
        ? await lstat(".", { bigint: true })
        : await rootHandle!.stat({ bigint: true });
    const currentGeneration =
      process.platform === "win32"
        ? await lstat("generation", { bigint: true })
        : await generationHandle!.stat({ bigint: true });
    const currentGenerationPath = await lstat("generation", { bigint: true });
    if (
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(currentRoot),
        rootIdentity,
      ) ||
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(currentGeneration),
        generationIdentity,
      ) ||
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(currentGenerationPath),
        generationIdentity,
      )
    ) {
      throw new Error("Bound removal generation changed after attestation");
    }

    if (process.platform === "linux") {
      await deleteBoundDirectoryContents(generationHandle, generationIdentity, generationMountId);
    } else {
      await runBoundCwdDirectoryChild("generation", generationIdentity, generationIdentity.device);
    }
    await generationHandle?.close();
    generationHandle = undefined;
    const generationBeforeRemoval = await lstat("generation", { bigint: true });
    if (
      !samePhysicalDirectoryIdentity(
        physicalDirectoryIdentityFromStats(generationBeforeRemoval),
        generationIdentity,
      )
    ) {
      throw new Error("Bound removal generation changed before root removal");
    }
    await rmdir("generation");
    if ((await readdir(rootTraversalPath)).length !== 0) {
      throw new Error("Bound removal root was not empty after generation deletion");
    }
    await writeMessage({ type: "completed", token });
  } finally {
    await generationHandle?.close();
    await rootHandle?.close();
  }
}

async function main(): Promise<void> {
  const token = process.argv[2];
  const mode = process.argv[3] ?? "root";
  if (token === undefined || token.length === 0) {
    throw new Error("Bound removal worker token is missing");
  }
  if (
    (process.platform !== "linux" &&
      process.platform !== "darwin" &&
      process.platform !== "win32") ||
    (process.platform !== "win32" && !hasDirectoryCapabilityFlags)
  ) {
    throw new Error("Bound removal has no descriptor-rooted directory API on this platform");
  }
  if (mode === "root") {
    await runRootWorker(token);
    return;
  }
  if (mode === "directory") {
    await runDirectoryWorker(token);
    return;
  }
  throw new Error("Bound removal worker mode is invalid");
}

void main().then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    process.stdin.destroy();
    process.stderr.write(
      error instanceof Error && error.stack ? error.stack : String(error),
      () => {
        process.exitCode = 1;
      },
    );
  },
);
