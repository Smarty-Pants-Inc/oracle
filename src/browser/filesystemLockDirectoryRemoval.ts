import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdtemp, open, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { createInterface } from "node:readline";
import { delay } from "./utils.js";
import {
  isRetryableWindowsLockMutationError,
  readErrorCode,
  renameLockPath,
  syncDirectory,
  syncDirectoryIfPresent,
  WINDOWS_LOCK_MUTATION_RETRY_MS,
  WINDOWS_LOCK_MUTATION_TIMEOUT_MS,
} from "./filesystemLockIo.js";

const ISOLATED_REMOVAL_ROOT_PREFIX = ".oracle-remove-";
const ISOLATED_REMOVAL_GENERATION_NAME = "generation";
const ISOLATED_REMOVAL_JOURNAL_SUFFIX = ".cleanup-journal.json";
const ISOLATED_REMOVAL_COMPLETION_SUFFIX = ".contents-deleted.json";
const REMOVAL_HELPER_ATTESTATION_TIMEOUT_MS = 10_000;

function isolatedDirectoryRemovalRootPrefix(replayKey: string): string {
  const digest = createHash("sha256").update(path.resolve(replayKey)).digest("hex");
  return `${ISOLATED_REMOVAL_ROOT_PREFIX}${digest}-`;
}

interface IsolatedDirectoryIdentity {
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string;
}

interface IsolatedDirectoryCleanupJournal {
  readonly version: 1;
  readonly platform: NodeJS.Platform;
  readonly journalNonce: string;
  readonly rootPath: string;
  readonly rootIdentity: IsolatedDirectoryIdentity;
  readonly generationName: typeof ISOLATED_REMOVAL_GENERATION_NAME;
  readonly generationIdentity: IsolatedDirectoryIdentity;
}

interface IsolatedDirectoryCleanupCompletion extends IsolatedDirectoryCleanupJournal {
  readonly contentsDeleted: true;
}

export interface IsolatedDirectoryRemovalDeps {
  afterChildAttestation?: (rootPath: string) => void | Promise<void>;
}

interface RemovalHelperAttestation {
  readonly type: "attested";
  readonly token: string;
  readonly rootIdentity: IsolatedDirectoryIdentity;
  readonly generationIdentity: IsolatedDirectoryIdentity;
}

const BOUND_DIRECTORY_REMOVAL_HELPER = String.raw`
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { constants } = require("node:fs");
const { createInterface } = require("node:readline");

const descriptorRoot = process.platform === "linux" ? "/proc/self/fd" : null;
const hasDirectoryCapabilityFlags =
  Number.isInteger(constants.O_RDONLY) &&
  Number.isInteger(constants.O_DIRECTORY) &&
  Number.isInteger(constants.O_NOFOLLOW);
const directoryOpenFlags = hasDirectoryCapabilityFlags
  ? constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  : 0;

function identity(entry) {
  return {
    device: entry.dev.toString(),
    inode: entry.ino.toString(),
    birthtimeNs: entry.birthtimeNs.toString(),
  };
}

function sameIdentity(left, right) {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs;
}

function isIdentity(value) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.device === "string" &&
    typeof value.inode === "string" &&
    typeof value.birthtimeNs === "string" &&
    Object.keys(value).sort().join(",") === "birthtimeNs,device,inode";
}

function descriptorPath(handle) {
  if (descriptorRoot === null) {
    throw new Error("Bound removal has no descriptor-rooted directory API on this platform");
  }
  return descriptorRoot + "/" + handle.fd;
}

function descriptorTraversalPath(handle) {
  if (process.platform !== "linux") {
    throw new Error("Bound removal has no traversable descriptor path on this platform");
  }
  return descriptorPath(handle);
}

function assertSameDevice(entry, expectedDevice, entryPath) {
  const observedDevice = entry.dev.toString();
  if (expectedDevice === "0" || observedDevice === "0") {
    throw new Error("Bound removal cannot prove the filesystem boundary at " + entryPath);
  }
  if (observedDevice !== expectedDevice) {
    throw new Error("Bound removal refused to cross a filesystem boundary at " + entryPath);
  }
}

async function readMountId(handle) {
  if (process.platform !== "linux") return null;
  const raw = await fs.readFile("/proc/self/fdinfo/" + handle.fd, "utf8");
  const match = raw.match(/^mnt_id:\s+(\d+)$/m);
  if (!match) throw new Error("Bound removal cannot prove the Linux mount generation");
  return match[1];
}

function writeMessage(message) {
  const deferred = Promise.withResolvers();
  process.stdout.write(JSON.stringify(message) + "\n", (error) => {
    if (error) deferred.reject(error);
    else deferred.resolve();
  });
  return deferred.promise;
}

async function readGo(token) {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    const newline = input.indexOf("\n");
    if (newline < 0) continue;
    const message = JSON.parse(input.slice(0, newline));
    if (!message || message.type !== "go" || message.token !== token) {
      throw new Error("Bound removal helper received an invalid go signal");
    }
    process.stdin.destroy();
    return;
  }
  throw new Error("Bound removal helper exited without an explicit go signal");
}

function delay(ms) {
  const deferred = Promise.withResolvers();
  setTimeout(deferred.resolve, ms);
  return deferred.promise;
}

// Darwin /dev/fd entries expose synthetic fdescfs metadata and cannot be traversed. Each worker
// instead starts in the already-opened directory, attests that kernel-bound cwd, and waits for go.
async function runDarwinBoundDirectoryChild(
  entryPath,
  expectedIdentity,
  expectedDevice,
) {
  const token = randomUUID();
  const child = spawn(process.execPath, [...process.execArgv, token, "directory"], {
    cwd: entryPath,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let childError;
  let stderr = "";
  let stderrTruncated = false;
  const childClosed = Promise.withResolvers();
  child.once("close", (code, signal) => childClosed.resolve({ code, signal }));
  child.once("error", (error) => {
    childError = error;
  });
  child.stdin.on("error", () => undefined);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const remaining = 16_384 - stderr.length;
    if (remaining > 0) stderr += chunk.slice(0, remaining);
    if (chunk.length > remaining) stderrTruncated = true;
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  let exit;
  const describeExit = async () => {
    exit = exit ?? await Promise.race([childClosed.promise, delay(1_000).then(() => null)]);
    const details = [];
    if (childError) details.push(childError.message);
    if (stderr.trim()) {
      details.push(stderr.trim() + (stderrTruncated ? " [stderr truncated]" : ""));
    }
    if (exit) details.push("exit " + String(exit.code) + " signal " + String(exit.signal));
    else details.push("stdout closed while child remained running");
    return details.join("; ");
  };
  const readLine = async () => {
    const result = await iterator.next();
    if (result.done) {
      throw new Error(
        "Bound removal directory child closed stdout before completing its protocol: " +
          await describeExit(),
      );
    }
    return result.value;
  };

  try {
    const attestation = JSON.parse(await readLine());
    if (
      !attestation ||
      attestation.type !== "attested-directory" ||
      attestation.token !== token ||
      !isIdentity(attestation.directoryIdentity) ||
      attestation.mountId !== null ||
      Object.keys(attestation).sort().join(",") !==
        "directoryIdentity,mountId,token,type" ||
      !sameIdentity(attestation.directoryIdentity, expectedIdentity) ||
      attestation.directoryIdentity.device !== expectedDevice
    ) {
      throw new Error("Bound removal directory child attested the wrong generation");
    }
    const completionLinePromise = readLine();
    child.stdin.end(JSON.stringify({ type: "go", token }) + "\n");
    const completion = JSON.parse(await completionLinePromise);
    if (
      !completion ||
      completion.type !== "completed" ||
      completion.token !== token ||
      Object.keys(completion).sort().join(",") !== "token,type"
    ) {
      throw new Error("Bound removal directory child returned an invalid completion");
    }
    exit = await childClosed.promise;
    if (childError || exit.code !== 0) {
      throw new Error("Bound removal directory child failed: " + await describeExit());
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
  directoryHandle,
  expectedIdentity,
  expectedMountId,
) {
  const directoryEntry = await directoryHandle.stat({ bigint: true });
  if (!sameIdentity(identity(directoryEntry), expectedIdentity)) {
    throw new Error("Bound removal directory generation changed before traversal");
  }
  assertSameDevice(directoryEntry, expectedIdentity.device, ".");
  const directoryPath = process.platform === "linux"
    ? descriptorTraversalPath(directoryHandle)
    : ".";
  for (const name of await fs.readdir(directoryPath)) {
    const entryPath = path.join(directoryPath, name);
    const before = await fs.lstat(entryPath, { bigint: true });
    if (before.isSymbolicLink()) {
      await fs.unlink(entryPath);
      continue;
    }
    assertSameDevice(before, expectedIdentity.device, entryPath);
    if (!before.isDirectory()) {
      const current = await fs.lstat(entryPath, { bigint: true });
      if (!sameIdentity(identity(before), identity(current))) {
        throw new Error("Bound removal file generation changed at " + entryPath);
      }
      await fs.unlink(entryPath);
      continue;
    }

    let childHandle;
    try {
      childHandle = await fs.open(entryPath, directoryOpenFlags);
      const childEntry = await childHandle.stat({ bigint: true });
      if (!childEntry.isDirectory() || !sameIdentity(identity(before), identity(childEntry))) {
        throw new Error("Bound removal directory generation changed at " + entryPath);
      }
      const childIdentity = identity(childEntry);
      assertSameDevice(childEntry, expectedIdentity.device, entryPath);
      const childMountId = await readMountId(childHandle);
      if (expectedMountId !== null && childMountId !== expectedMountId) {
        throw new Error("Bound removal refused to cross a mount boundary at " + entryPath);
      }
      if (process.platform === "linux") {
        await deleteBoundDirectoryContents(childHandle, childIdentity, expectedMountId);
      } else {
        await runDarwinBoundDirectoryChild(
          entryPath,
          childIdentity,
          expectedIdentity.device,
        );
      }
    } finally {
      await childHandle?.close();
    }

    const current = await fs.lstat(entryPath, { bigint: true });
    if (!sameIdentity(identity(before), identity(current))) {
      throw new Error("Bound removal directory generation changed before removal at " + entryPath);
    }
    await fs.rmdir(entryPath);
  }
}

async function runDirectoryWorker(token) {
  if (process.platform !== "darwin") {
    throw new Error("Bound removal cwd worker is only available on Darwin");
  }
  let directoryHandle;
  try {
    const pathEntry = await fs.lstat(".", { bigint: true });
    directoryHandle = await fs.open(".", directoryOpenFlags);
    const directoryEntry = await directoryHandle.stat({ bigint: true });
    if (
      !directoryEntry.isDirectory() ||
      !sameIdentity(identity(pathEntry), identity(directoryEntry))
    ) {
      throw new Error("Bound removal directory generation changed while opening capability");
    }
    await fs.readdir(".");
    assertSameDevice(directoryEntry, directoryEntry.dev.toString(), ".");
    const directoryIdentity = identity(directoryEntry);
    await writeMessage({
      type: "attested-directory",
      token,
      directoryIdentity,
      mountId: null,
    });
    await readGo(token);

    const currentPathEntry = await fs.lstat(".", { bigint: true });
    const currentEntry = await directoryHandle.stat({ bigint: true });
    if (
      !sameIdentity(identity(currentPathEntry), directoryIdentity) ||
      !sameIdentity(identity(currentEntry), directoryIdentity)
    ) {
      throw new Error("Bound removal directory generation changed after attestation");
    }
    await deleteBoundDirectoryContents(directoryHandle, directoryIdentity, null);
    await writeMessage({ type: "completed", token });
  } finally {
    await directoryHandle?.close();
  }
}

async function runRootWorker(token) {
  const entries = await fs.readdir(".");
  if (entries.length !== 1 || entries[0] !== "generation") {
    throw new Error("Bound removal root does not contain exactly one generation");
  }

  let rootHandle;
  let generationHandle;
  try {
    const rootPathEntry = await fs.lstat(".", { bigint: true });
    const generationPathEntry = await fs.lstat("generation", { bigint: true });
    rootHandle = await fs.open(".", directoryOpenFlags);
    generationHandle = await fs.open("generation", directoryOpenFlags);
    const rootEntry = await rootHandle.stat({ bigint: true });
    const generationEntry = await generationHandle.stat({ bigint: true });
    try {
      if (process.platform === "linux") {
        const rootedRootEntry = await fs.stat(descriptorPath(rootHandle), { bigint: true });
        const rootedGenerationEntry = await fs.stat(descriptorPath(generationHandle), {
          bigint: true,
        });
        if (
          !sameIdentity(identity(rootedRootEntry), identity(rootEntry)) ||
          !sameIdentity(identity(rootedGenerationEntry), identity(generationEntry))
        ) {
          throw new Error("descriptor paths resolved to different generations");
        }
        await fs.readdir(descriptorTraversalPath(rootHandle));
        await fs.readdir(descriptorTraversalPath(generationHandle));
      } else {
        await fs.readdir(".");
        await fs.readdir("generation");
      }
    } catch (error) {
      const detail = error && typeof error === "object" && typeof error.message === "string"
        ? (typeof error.code === "string" ? error.code + ": " : "") + error.message
        : String(error);
      throw new Error("Bound removal held-directory capability is unavailable: " + detail, {
        cause: error,
      });
    }
    if (
      !rootEntry.isDirectory() ||
      !generationEntry.isDirectory() ||
      !sameIdentity(identity(rootPathEntry), identity(rootEntry)) ||
      !sameIdentity(identity(generationPathEntry), identity(generationEntry))
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

    const rootIdentity = identity(rootEntry);
    const generationIdentity = identity(generationEntry);
    await writeMessage({
      type: "attested",
      token,
      rootIdentity,
      generationIdentity,
    });
    await readGo(token);

    const rootTraversalPath = process.platform === "linux"
      ? descriptorTraversalPath(rootHandle)
      : ".";
    const currentEntries = await fs.readdir(rootTraversalPath);
    if (currentEntries.length !== 1 || currentEntries[0] !== "generation") {
      throw new Error("Bound removal root changed after attestation");
    }
    const currentRoot = await rootHandle.stat({ bigint: true });
    const currentGeneration = await generationHandle.stat({ bigint: true });
    const currentGenerationPath = await fs.lstat("generation", { bigint: true });
    if (
      !sameIdentity(identity(currentRoot), rootIdentity) ||
      !sameIdentity(identity(currentGeneration), generationIdentity) ||
      !sameIdentity(identity(currentGenerationPath), generationIdentity)
    ) {
      throw new Error("Bound removal generation changed after attestation");
    }

    if (process.platform === "linux") {
      await deleteBoundDirectoryContents(
        generationHandle,
        generationIdentity,
        generationMountId,
      );
    } else {
      await runDarwinBoundDirectoryChild(
        "generation",
        generationIdentity,
        generationIdentity.device,
      );
    }
    await generationHandle.close();
    generationHandle = undefined;
    const generationBeforeRemoval = await fs.lstat("generation", { bigint: true });
    if (!sameIdentity(identity(generationBeforeRemoval), generationIdentity)) {
      throw new Error("Bound removal generation changed before root removal");
    }
    await fs.rmdir("generation");
    if ((await fs.readdir(rootTraversalPath)).length !== 0) {
      throw new Error("Bound removal root was not empty after generation deletion");
    }
    await writeMessage({ type: "completed", token });
  } finally {
    await generationHandle?.close();
    await rootHandle?.close();
  }
}

(async () => {
  const token = process.argv[1];
  const mode = process.argv[2] ?? "root";
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("Bound removal helper token is missing");
  }
  if (
    (process.platform !== "linux" && process.platform !== "darwin") ||
    !hasDirectoryCapabilityFlags
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
  throw new Error("Bound removal helper mode is invalid");
})().then(
  () => {
    process.exitCode = 0;
  },
  (error) => {
    process.stdin.destroy();
    process.stderr.write((error && error.stack) || String(error), () => {
      process.exitCode = 1;
    });
  },
);
`;

// The journal is durable before the candidate rename. A crash can therefore leave either an
// empty prepared root or the exact moved generation, and restart can distinguish both without
// recursively following the pathname.
export async function isolateDirectoryGenerationForRemoval(
  candidatePath: string,
  verifyGeneration: (generationPath: string) => Promise<boolean>,
  replayKey = candidatePath,
): Promise<
  | { status: "isolated"; rootPath: string; generationPath: string }
  | { status: "missing" }
  | { status: "changed" }
> {
  const canonicalCandidatePath = path.resolve(candidatePath);
  const parentPath = path.dirname(canonicalCandidatePath);
  const canonicalReplayKey = path.resolve(replayKey);
  if (path.dirname(canonicalReplayKey) !== parentPath) {
    throw new Error(`Isolated cleanup replay key escapes its parent directory: ${replayKey}`);
  }
  const rootPath = await mkdtemp(
    path.join(parentPath, isolatedDirectoryRemovalRootPrefix(canonicalReplayKey)),
  );
  try {
    await chmod(rootPath, 0o700);
  } catch (error) {
    await removeFreshEmptyIsolationRoot(rootPath);
    throw error;
  }

  const rootIdentity = await captureIsolatedDirectoryIdentity(rootPath);
  let generationIdentity: IsolatedDirectoryIdentity;
  try {
    generationIdentity = await captureIsolatedDirectoryIdentity(canonicalCandidatePath);
  } catch (error) {
    await removeFreshEmptyIsolationRoot(rootPath);
    if (readErrorCode(error) === "ENOENT") return { status: "missing" };
    throw error;
  }

  let matches: boolean;
  try {
    matches = await verifyGeneration(canonicalCandidatePath);
  } catch (error) {
    await removeFreshEmptyIsolationRoot(rootPath);
    throw error;
  }
  const candidateAfterVerification = await inspectIsolatedDirectoryIdentity(
    canonicalCandidatePath,
    generationIdentity,
  );
  if (!matches || candidateAfterVerification !== "matches") {
    await removeFreshEmptyIsolationRoot(rootPath);
    return candidateAfterVerification === "missing" ? { status: "missing" } : { status: "changed" };
  }

  const journal: IsolatedDirectoryCleanupJournal = {
    version: 1,
    platform: process.platform,
    journalNonce: randomUUID(),
    rootPath,
    rootIdentity,
    generationName: ISOLATED_REMOVAL_GENERATION_NAME,
    generationIdentity,
  };
  await persistIsolatedDirectoryCleanupJournal(journal);
  if ((await inspectIsolatedDirectoryIdentity(rootPath, rootIdentity)) !== "matches") {
    throw new Error(`Isolated cleanup root changed before generation move: ${rootPath}`);
  }

  const generationPath = path.join(rootPath, ISOLATED_REMOVAL_GENERATION_NAME);
  try {
    await renameLockPath(canonicalCandidatePath, generationPath);
  } catch (error) {
    try {
      await removeIsolatedDirectoryGeneration(rootPath);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Filesystem generation isolation and prepared-journal cleanup both failed at ${canonicalCandidatePath}`,
      );
    }
    if (readErrorCode(error) === "ENOENT") return { status: "missing" };
    throw error;
  }

  try {
    await syncDirectory(rootPath);
    await syncDirectory(parentPath);
    if (
      (await inspectIsolatedDirectoryIdentity(rootPath, rootIdentity)) !== "matches" ||
      (await inspectIsolatedDirectoryIdentity(generationPath, generationIdentity)) !== "matches"
    ) {
      throw new Error(`Filesystem isolated generation changed at ${canonicalCandidatePath}`);
    }
    matches = await verifyGeneration(generationPath);
    if (
      (await inspectIsolatedDirectoryIdentity(generationPath, generationIdentity)) !== "matches"
    ) {
      throw new Error(`Filesystem isolated generation changed at ${canonicalCandidatePath}`);
    }
  } catch (error) {
    await restoreIsolatedDirectoryGeneration(
      canonicalCandidatePath,
      rootPath,
      generationPath,
      journal,
    );
    throw error;
  }
  if (!matches) {
    await restoreIsolatedDirectoryGeneration(
      canonicalCandidatePath,
      rootPath,
      generationPath,
      journal,
    );
    return { status: "changed" };
  }
  return { status: "isolated", rootPath, generationPath };
}

export async function removeIsolatedDirectoryGeneration(
  rootPath: string,
  deps: IsolatedDirectoryRemovalDeps = {},
): Promise<void> {
  const canonicalRootPath = path.resolve(rootPath);
  const journalPath = isolatedDirectoryCleanupJournalPath(canonicalRootPath);
  const completionPath = isolatedDirectoryCleanupCompletionPath(canonicalRootPath);
  let journal: IsolatedDirectoryCleanupJournal;
  try {
    journal = await readIsolatedDirectoryCleanupJournal(journalPath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    try {
      journal = await readIsolatedDirectoryCleanupCompletion(completionPath);
    } catch (completionError) {
      if (readErrorCode(completionError) === "ENOENT") {
        try {
          await lstat(canonicalRootPath);
        } catch (rootError) {
          if (readErrorCode(rootError) === "ENOENT") return;
          throw rootError;
        }
      }
      throw completionError;
    }
  }
  if (journal.rootPath !== canonicalRootPath) {
    throw new Error(`Isolated cleanup journal does not authorize ${canonicalRootPath}`);
  }

  const completion = await readIsolatedDirectoryCleanupCompletion(completionPath, true);
  if (completion !== null) {
    assertCleanupCompletionMatchesJournal(completion, journal);
    await finalizeIsolatedDirectoryCleanup(journal, journalPath, completionPath);
    return;
  }

  const rootStatus = await inspectIsolatedDirectoryIdentity(
    canonicalRootPath,
    journal.rootIdentity,
  );
  if (rootStatus !== "matches") {
    throw new Error(
      `Isolated cleanup root identity changed at ${canonicalRootPath}; cleanup remains pending`,
    );
  }
  const entries = await readdir(canonicalRootPath);
  if (entries.length === 0) {
    await persistIsolatedDirectoryCleanupCompletion(journal, completionPath);
  } else {
    if (entries.length !== 1 || entries[0] !== journal.generationName) {
      throw new Error(
        `Isolated cleanup root contains unjournaled entries at ${canonicalRootPath}; cleanup remains pending`,
      );
    }
    const generationPath = path.join(canonicalRootPath, journal.generationName);
    if (
      (await inspectIsolatedDirectoryIdentity(generationPath, journal.generationIdentity)) !==
      "matches"
    ) {
      throw new Error(
        `Isolated cleanup generation identity changed at ${generationPath}; cleanup remains pending`,
      );
    }
    await deleteIsolatedGenerationWithBoundHelper(journal, deps);
    await persistIsolatedDirectoryCleanupCompletion(journal, completionPath);
  }
  await finalizeIsolatedDirectoryCleanup(journal, journalPath, completionPath);
}
export async function replayPendingIsolatedDirectoryRemovals(
  parentPath: string,
  replayKey?: string,
): Promise<void> {
  const canonicalParentPath = path.resolve(parentPath);
  const canonicalReplayKey = replayKey === undefined ? undefined : path.resolve(replayKey);
  if (
    canonicalReplayKey !== undefined &&
    path.dirname(canonicalReplayKey) !== canonicalParentPath
  ) {
    throw new Error(`Isolated cleanup replay key escapes its parent directory: ${replayKey}`);
  }
  const rootPrefix =
    canonicalReplayKey === undefined
      ? ISOLATED_REMOVAL_ROOT_PREFIX
      : isolatedDirectoryRemovalRootPrefix(canonicalReplayKey);
  let entries: Dirent[];
  try {
    entries = await readdir(canonicalParentPath, { withFileTypes: true });
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return;
    throw error;
  }
  const cleanupAuthorityNames = entries
    .map((entry) => entry.name)
    .filter(
      (name) =>
        name.startsWith(rootPrefix) &&
        (name.endsWith(ISOLATED_REMOVAL_JOURNAL_SUFFIX) ||
          name.endsWith(ISOLATED_REMOVAL_COMPLETION_SUFFIX)),
    )
    .sort();
  const rootPaths = new Set<string>();
  for (const authorityName of cleanupAuthorityNames) {
    const authorityPath = path.join(canonicalParentPath, authorityName);
    const authority = authorityName.endsWith(ISOLATED_REMOVAL_JOURNAL_SUFFIX)
      ? await readIsolatedDirectoryCleanupJournal(authorityPath)
      : await readIsolatedDirectoryCleanupCompletion(authorityPath);
    if (path.dirname(authority.rootPath) !== canonicalParentPath) {
      throw new Error(`Isolated cleanup authority escapes its parent directory: ${authorityPath}`);
    }
    rootPaths.add(authority.rootPath);
  }
  for (const rootPath of [...rootPaths].sort()) {
    await removeIsolatedDirectoryGeneration(rootPath);
  }
}

async function restoreIsolatedDirectoryGeneration(
  candidatePath: string,
  rootPath: string,
  generationPath: string,
  journal: IsolatedDirectoryCleanupJournal,
): Promise<void> {
  if (
    (await inspectIsolatedDirectoryIdentity(rootPath, journal.rootIdentity)) !== "matches" ||
    (await inspectIsolatedDirectoryIdentity(generationPath, journal.generationIdentity)) !==
      "matches"
  ) {
    throw new Error(
      `Filesystem generation changed at ${candidatePath}; unexpected directory preserved at ${generationPath}`,
    );
  }
  try {
    await renameLockPath(generationPath, candidatePath);
    await syncDirectory(path.dirname(candidatePath));
  } catch (error) {
    throw new Error(
      `Filesystem generation changed at ${candidatePath}; unexpected directory preserved at ${generationPath}`,
      { cause: error },
    );
  }
  await removeIsolatedDirectoryGeneration(rootPath);
}

async function deleteIsolatedGenerationWithBoundHelper(
  journal: IsolatedDirectoryCleanupJournal,
  deps: IsolatedDirectoryRemovalDeps,
): Promise<void> {
  const token = randomUUID();
  const child = spawn(process.execPath, ["-e", BOUND_DIRECTORY_REMOVAL_HELPER, token], {
    cwd: journal.rootPath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "",
      NODE_PATH: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let childError: Error | undefined;
  let childExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
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
  const describeChildExit = async (): Promise<string> => {
    if (childExit === null) {
      const boundedWait = Promise.withResolvers<null>();
      const timeout = setTimeout(() => boundedWait.resolve(null), 1_000);
      try {
        childExit = await Promise.race([childClosed.promise, boundedWait.promise]);
      } finally {
        clearTimeout(timeout);
      }
    }
    const details: string[] = [];
    if (childError !== undefined) details.push(childError.message);
    if (stderr.trim()) {
      details.push(`${stderr.trim()}${stderrTruncated ? " [stderr truncated]" : ""}`);
    }
    if (childExit !== null) {
      details.push(`exit ${String(childExit.code)} signal ${String(childExit.signal)}`);
    } else {
      details.push("stdout closed while child remained running");
    }
    return details.join("; ");
  };
  const earlyExitMessage = async (): Promise<string> =>
    `Bound removal helper closed stdout at ${journal.rootPath} before completing its protocol: ${await describeChildExit()}`;

  try {
    const attestation = parseRemovalHelperAttestation(
      await readRemovalHelperLine(
        iterator,
        earlyExitMessage,
        REMOVAL_HELPER_ATTESTATION_TIMEOUT_MS,
      ),
    );
    if (
      attestation.token !== token ||
      !sameIsolatedDirectoryIdentity(attestation.rootIdentity, journal.rootIdentity) ||
      !sameIsolatedDirectoryIdentity(attestation.generationIdentity, journal.generationIdentity)
    ) {
      throw new Error(`Bound removal helper attested the wrong generation at ${journal.rootPath}`);
    }
    await deps.afterChildAttestation?.(journal.rootPath);
    // Arm the read before releasing the helper so a fast deletion cannot close stdout first.
    const completionLinePromise = readRemovalHelperLine(iterator, earlyExitMessage);
    child.stdin.end(`${JSON.stringify({ type: "go", token })}\n`);

    const completion = JSON.parse(await completionLinePromise) as unknown;
    if (
      !isPlainRecord(completion) ||
      completion.type !== "completed" ||
      completion.token !== token ||
      Object.keys(completion).sort().join(",") !== "token,type"
    ) {
      throw new Error(`Bound removal helper returned an invalid completion at ${journal.rootPath}`);
    }
    childExit = await childClosed.promise;
    if (childError !== undefined || childExit.code !== 0) {
      throw new Error(
        `Bound removal helper failed at ${journal.rootPath}: ${await describeChildExit()}`,
      );
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

async function readRemovalHelperLine(
  iterator: AsyncIterator<string>,
  earlyExitMessage: () => Promise<string>,
  timeoutMs?: number,
): Promise<string> {
  const nextLine = iterator.next().then(async (result) => {
    if (result.done) throw new Error(await earlyExitMessage());
    return result.value;
  });
  if (timeoutMs === undefined) return nextLine;
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = Promise.withResolvers<never>();
  try {
    timeout = setTimeout(
      () => timedOut.reject(new Error("Bound removal helper attestation timed out")),
      timeoutMs,
    );
    return await Promise.race([nextLine, timedOut.promise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function parseRemovalHelperAttestation(raw: string): RemovalHelperAttestation {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error("Bound removal helper returned malformed attestation", { cause: error });
  }
  if (
    !isPlainRecord(value) ||
    value.type !== "attested" ||
    typeof value.token !== "string" ||
    Object.keys(value).sort().join(",") !== "generationIdentity,rootIdentity,token,type"
  ) {
    throw new Error("Bound removal helper returned invalid attestation");
  }
  const rootIdentity = parseIsolatedDirectoryIdentity(value.rootIdentity);
  const generationIdentity = parseIsolatedDirectoryIdentity(value.generationIdentity);
  if (rootIdentity === null || generationIdentity === null) {
    throw new Error("Bound removal helper returned invalid generation identity");
  }
  return {
    type: "attested",
    token: value.token,
    rootIdentity,
    generationIdentity,
  };
}

async function persistIsolatedDirectoryCleanupJournal(
  journal: IsolatedDirectoryCleanupJournal,
): Promise<void> {
  if (
    (await inspectIsolatedDirectoryIdentity(journal.rootPath, journal.rootIdentity)) !== "matches"
  ) {
    throw new Error(`Isolated cleanup root changed before journaling: ${journal.rootPath}`);
  }
  await writeDurableExclusiveJson(isolatedDirectoryCleanupJournalPath(journal.rootPath), journal);
}

async function persistIsolatedDirectoryCleanupCompletion(
  journal: IsolatedDirectoryCleanupJournal,
  completionPath: string,
): Promise<void> {
  const completion: IsolatedDirectoryCleanupCompletion = {
    ...journal,
    contentsDeleted: true,
  };
  try {
    await writeDurableExclusiveJson(completionPath, completion);
  } catch (error) {
    if (readErrorCode(error) !== "EEXIST") throw error;
    assertCleanupCompletionMatchesJournal(
      await readIsolatedDirectoryCleanupCompletion(completionPath),
      journal,
    );
  }
}

async function writeDurableExclusiveJson(filePath: string, value: unknown): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(filePath));
}

async function readIsolatedDirectoryCleanupJournal(
  journalPath: string,
): Promise<IsolatedDirectoryCleanupJournal> {
  const value = await readStableCleanupJson(journalPath);
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "generationIdentity,generationName,journalNonce,platform,rootIdentity,rootPath,version" ||
    value.version !== 1 ||
    value.platform !== process.platform ||
    typeof value.journalNonce !== "string" ||
    value.journalNonce.length === 0 ||
    typeof value.rootPath !== "string" ||
    path.resolve(value.rootPath) !== value.rootPath ||
    value.generationName !== ISOLATED_REMOVAL_GENERATION_NAME
  ) {
    throw new Error(`Malformed isolated cleanup journal: ${journalPath}`);
  }
  const rootIdentity = parseIsolatedDirectoryIdentity(value.rootIdentity);
  const generationIdentity = parseIsolatedDirectoryIdentity(value.generationIdentity);
  if (
    rootIdentity === null ||
    generationIdentity === null ||
    isolatedDirectoryCleanupJournalPath(value.rootPath) !== path.resolve(journalPath)
  ) {
    throw new Error(`Malformed isolated cleanup journal: ${journalPath}`);
  }
  return {
    version: 1,
    platform: process.platform,
    journalNonce: value.journalNonce,
    rootPath: value.rootPath,
    rootIdentity,
    generationName: ISOLATED_REMOVAL_GENERATION_NAME,
    generationIdentity,
  };
}

async function readIsolatedDirectoryCleanupCompletion(
  completionPath: string,
  missingAsNull: true,
): Promise<IsolatedDirectoryCleanupCompletion | null>;
async function readIsolatedDirectoryCleanupCompletion(
  completionPath: string,
  missingAsNull?: false,
): Promise<IsolatedDirectoryCleanupCompletion>;
async function readIsolatedDirectoryCleanupCompletion(
  completionPath: string,
  missingAsNull = false,
): Promise<IsolatedDirectoryCleanupCompletion | null> {
  let value: unknown;
  try {
    value = await readStableCleanupJson(completionPath);
  } catch (error) {
    if (missingAsNull && readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "contentsDeleted,generationIdentity,generationName,journalNonce,platform,rootIdentity,rootPath,version" ||
    value.contentsDeleted !== true ||
    value.version !== 1 ||
    value.platform !== process.platform ||
    typeof value.journalNonce !== "string" ||
    value.journalNonce.length === 0 ||
    typeof value.rootPath !== "string" ||
    path.resolve(value.rootPath) !== value.rootPath ||
    value.generationName !== ISOLATED_REMOVAL_GENERATION_NAME ||
    isolatedDirectoryCleanupCompletionPath(value.rootPath) !== path.resolve(completionPath)
  ) {
    throw new Error(`Malformed isolated cleanup completion receipt: ${completionPath}`);
  }
  const rootIdentity = parseIsolatedDirectoryIdentity(value.rootIdentity);
  const generationIdentity = parseIsolatedDirectoryIdentity(value.generationIdentity);
  if (rootIdentity === null || generationIdentity === null) {
    throw new Error(`Malformed isolated cleanup completion receipt: ${completionPath}`);
  }
  return {
    version: 1,
    platform: process.platform,
    journalNonce: value.journalNonce,
    rootPath: value.rootPath,
    rootIdentity,
    generationName: ISOLATED_REMOVAL_GENERATION_NAME,
    generationIdentity,
    contentsDeleted: true,
  };
}

async function readStableCleanupJson(filePath: string): Promise<unknown> {
  const before = await lstat(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Cleanup authority is not a physical file: ${filePath}`);
  }
  const raw = await readFile(filePath, "utf8");
  const after = await lstat(filePath, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.birthtimeNs !== after.birthtimeNs ||
    before.ctimeNs !== after.ctimeNs ||
    before.size !== after.size
  ) {
    throw new Error(`Cleanup authority changed while being read: ${filePath}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Malformed cleanup authority JSON: ${filePath}`, { cause: error });
  }
}

async function finalizeIsolatedDirectoryCleanup(
  journal: IsolatedDirectoryCleanupJournal,
  journalPath: string,
  completionPath: string,
): Promise<void> {
  const rootStatus = await inspectIsolatedDirectoryIdentity(journal.rootPath, journal.rootIdentity);
  if (rootStatus === "changed") {
    throw new Error(
      `Isolated cleanup root identity changed at ${journal.rootPath}; cleanup remains pending`,
    );
  }
  if (rootStatus === "matches") {
    if ((await readdir(journal.rootPath)).length !== 0) {
      throw new Error(`Isolated cleanup root is not empty at ${journal.rootPath}`);
    }
    const deadline = Date.now() + WINDOWS_LOCK_MUTATION_TIMEOUT_MS;
    for (;;) {
      if (
        (await inspectIsolatedDirectoryIdentity(journal.rootPath, journal.rootIdentity)) !==
        "matches"
      ) {
        throw new Error(
          `Isolated cleanup root identity changed at ${journal.rootPath}; cleanup remains pending`,
        );
      }
      try {
        await rmdir(journal.rootPath);
        break;
      } catch (error) {
        if (readErrorCode(error) === "ENOENT") break;
        if (!isRetryableWindowsLockMutationError(error) || Date.now() >= deadline) throw error;
      }
      await delay(Math.min(WINDOWS_LOCK_MUTATION_RETRY_MS, Math.max(1, deadline - Date.now())));
    }
  }
  const parentPath = path.dirname(journal.rootPath);
  await syncDirectory(parentPath);
  try {
    await unlink(journalPath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
  }
  await syncDirectory(parentPath);
  try {
    await unlink(completionPath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
  }
  await syncDirectory(parentPath);
}

async function removeFreshEmptyIsolationRoot(rootPath: string): Promise<void> {
  try {
    await rmdir(rootPath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
  }
  await syncDirectoryIfPresent(path.dirname(rootPath));
}

async function captureIsolatedDirectoryIdentity(
  directoryPath: string,
): Promise<IsolatedDirectoryIdentity> {
  const entry = await lstat(directoryPath, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Cleanup authority is not a physical directory: ${directoryPath}`);
  }
  return {
    device: entry.dev.toString(),
    inode: entry.ino.toString(),
    birthtimeNs: entry.birthtimeNs.toString(),
  };
}

async function inspectIsolatedDirectoryIdentity(
  directoryPath: string,
  expected: IsolatedDirectoryIdentity,
): Promise<"matches" | "missing" | "changed"> {
  let current: IsolatedDirectoryIdentity;
  try {
    current = await captureIsolatedDirectoryIdentity(directoryPath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return "missing";
    return "changed";
  }
  return sameIsolatedDirectoryIdentity(current, expected) ? "matches" : "changed";
}

function sameIsolatedDirectoryIdentity(
  left: IsolatedDirectoryIdentity,
  right: IsolatedDirectoryIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function parseIsolatedDirectoryIdentity(value: unknown): IsolatedDirectoryIdentity | null {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== "birthtimeNs,device,inode" ||
    typeof value.device !== "string" ||
    typeof value.inode !== "string" ||
    typeof value.birthtimeNs !== "string" ||
    !/^(?:0|[1-9]\d*)$/u.test(value.device) ||
    !/^(?:0|[1-9]\d*)$/u.test(value.inode) ||
    !/^(?:0|[1-9]\d*)$/u.test(value.birthtimeNs)
  ) {
    return null;
  }
  return {
    device: value.device,
    inode: value.inode,
    birthtimeNs: value.birthtimeNs,
  };
}

function assertCleanupCompletionMatchesJournal(
  completion: IsolatedDirectoryCleanupCompletion,
  journal: IsolatedDirectoryCleanupJournal,
): void {
  if (
    completion.journalNonce !== journal.journalNonce ||
    completion.rootPath !== journal.rootPath ||
    completion.platform !== journal.platform ||
    !sameIsolatedDirectoryIdentity(completion.rootIdentity, journal.rootIdentity) ||
    !sameIsolatedDirectoryIdentity(completion.generationIdentity, journal.generationIdentity)
  ) {
    throw new Error(
      `Isolated cleanup completion does not match its journal at ${journal.rootPath}`,
    );
  }
}

function isolatedDirectoryCleanupJournalPath(rootPath: string): string {
  return `${rootPath}${ISOLATED_REMOVAL_JOURNAL_SUFFIX}`;
}

function isolatedDirectoryCleanupCompletionPath(rootPath: string): string {
  return `${rootPath}${ISOLATED_REMOVAL_COMPLETION_SUFFIX}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
