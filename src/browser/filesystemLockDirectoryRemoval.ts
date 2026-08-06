import path from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  capturePhysicalDirectoryIdentity,
  parsePhysicalDirectoryIdentity,
  samePhysicalDirectoryIdentity,
} from "./filesystemLockDirectoryIdentity.js";
import type { PhysicalDirectoryIdentity } from "./filesystemLockDirectoryIdentity.js";
import {
  encodeDirectoryRemovalMessage,
  parseDirectoryRemovalMessage,
} from "./filesystemLockDirectoryRemovalProtocol.js";

const ISOLATED_REMOVAL_ROOT_PREFIX = ".oracle-remove-";
const ISOLATED_REMOVAL_GENERATION_NAME = "generation";
const ISOLATED_REMOVAL_JOURNAL_SUFFIX = ".cleanup-journal.json";
const ISOLATED_REMOVAL_COMPLETION_SUFFIX = ".contents-deleted.json";
const REMOVAL_HELPER_ATTESTATION_TIMEOUT_MS = 10_000;

function isolatedDirectoryRemovalRootPrefix(replayKey: string): string {
  const digest = createHash("sha256").update(path.resolve(replayKey)).digest("hex");
  return `${ISOLATED_REMOVAL_ROOT_PREFIX}${digest}-`;
}

type IsolatedDirectoryIdentity = PhysicalDirectoryIdentity;

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
  verifyGenerationForRemoval?: (generationPath: string) => Promise<boolean>;
}

interface InFlightIsolatedDirectoryRemoval {
  readonly removal: Promise<void>;
}

// Retained release and replay can converge on the same journal in one process. Only the first
// exact-authority attempt may spawn a removal helper; concurrent callers share its settlement.
const inFlightIsolatedDirectoryRemovals = new Map<string, InFlightIsolatedDirectoryRemoval>();
// Replay must not finalize a journaled empty root while its generation move is still in flight.
const inFlightIsolatedDirectoryPreparations = new Map<string, Promise<void>>();

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
  const preparation = Promise.withResolvers<void>();
  inFlightIsolatedDirectoryPreparations.set(rootPath, preparation.promise);
  try {
    try {
      await chmod(rootPath, 0o700);
    } catch (error) {
      await removeFreshEmptyIsolationRoot(rootPath);
      throw error;
    }

    const rootIdentity = await capturePhysicalDirectoryIdentity(rootPath);
    let generationIdentity: IsolatedDirectoryIdentity;
    try {
      generationIdentity = await capturePhysicalDirectoryIdentity(canonicalCandidatePath);
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
      return candidateAfterVerification === "missing"
        ? { status: "missing" }
        : { status: "changed" };
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
        await removeIsolatedDirectoryGenerationNow(rootPath);
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
  } finally {
    if (inFlightIsolatedDirectoryPreparations.get(rootPath) === preparation.promise) {
      inFlightIsolatedDirectoryPreparations.delete(rootPath);
    }
    preparation.resolve();
  }
}

export function removeIsolatedDirectoryGeneration(
  rootPath: string,
  deps: IsolatedDirectoryRemovalDeps = {},
): Promise<void> {
  const canonicalRootPath = path.resolve(rootPath);
  const preparation = inFlightIsolatedDirectoryPreparations.get(canonicalRootPath);
  if (preparation !== undefined) {
    return preparation.then(() => removeIsolatedDirectoryGeneration(canonicalRootPath, deps));
  }
  return removeIsolatedDirectoryGenerationNow(canonicalRootPath, deps);
}

function removeIsolatedDirectoryGenerationNow(
  canonicalRootPath: string,
  deps: IsolatedDirectoryRemovalDeps = {},
): Promise<void> {
  const existing = inFlightIsolatedDirectoryRemovals.get(canonicalRootPath);
  if (existing !== undefined) return existing.removal;

  const authority = readIsolatedDirectoryCleanupAuthority(canonicalRootPath);
  const removal: Promise<void> = authority.then(async (journal) => {
    if (journal === null) return;
    await removeAuthorizedIsolatedDirectoryGeneration(canonicalRootPath, journal, deps);
  });
  const entry = { removal };
  inFlightIsolatedDirectoryRemovals.set(canonicalRootPath, entry);
  const clear = (): void => {
    if (inFlightIsolatedDirectoryRemovals.get(canonicalRootPath) === entry) {
      inFlightIsolatedDirectoryRemovals.delete(canonicalRootPath);
    }
  };
  void removal.then(clear, clear);
  return removal;
}

async function readIsolatedDirectoryCleanupAuthority(
  canonicalRootPath: string,
): Promise<IsolatedDirectoryCleanupJournal | null> {
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
          if (readErrorCode(rootError) === "ENOENT") return null;
          throw rootError;
        }
      }
      throw completionError;
    }
  }
  if (journal.rootPath !== canonicalRootPath) {
    throw new Error(`Isolated cleanup journal does not authorize ${canonicalRootPath}`);
  }
  return journal;
}

async function removeAuthorizedIsolatedDirectoryGeneration(
  canonicalRootPath: string,
  journal: IsolatedDirectoryCleanupJournal,
  deps: IsolatedDirectoryRemovalDeps,
): Promise<void> {
  const journalPath = isolatedDirectoryCleanupJournalPath(canonicalRootPath);
  const completionPath = isolatedDirectoryCleanupCompletionPath(canonicalRootPath);
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
  if (rootStatus === "missing") {
    const racedCompletion = await readIsolatedDirectoryCleanupCompletion(completionPath, true);
    if (racedCompletion !== null) {
      assertCleanupCompletionMatchesJournal(racedCompletion, journal);
      await finalizeIsolatedDirectoryCleanup(journal, journalPath, completionPath);
      return;
    }
    try {
      await readIsolatedDirectoryCleanupJournal(journalPath);
    } catch (error) {
      if (readErrorCode(error) !== "ENOENT") throw error;
    }
    throw new Error(
      `Isolated cleanup root disappeared without a completion receipt at ${canonicalRootPath}; cleanup remains pending`,
    );
  }
  if (rootStatus === "changed") {
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
    if (
      deps.verifyGenerationForRemoval &&
      !(await deps.verifyGenerationForRemoval(generationPath))
    ) {
      throw new Error(
        `Isolated cleanup generation identity changed or is not proven safe to remove at ${generationPath}; cleanup remains pending`,
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
  deps: IsolatedDirectoryRemovalDeps = {},
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
    let authority: IsolatedDirectoryCleanupJournal | IsolatedDirectoryCleanupCompletion;
    try {
      authority = authorityName.endsWith(ISOLATED_REMOVAL_JOURNAL_SUFFIX)
        ? await readIsolatedDirectoryCleanupJournal(authorityPath)
        : await readIsolatedDirectoryCleanupCompletion(authorityPath);
    } catch (error) {
      if (readErrorCode(error) === "ENOENT") continue;
      throw error;
    }
    if (path.dirname(authority.rootPath) !== canonicalParentPath) {
      throw new Error(`Isolated cleanup authority escapes its parent directory: ${authorityPath}`);
    }
    rootPaths.add(authority.rootPath);
  }
  for (const rootPath of [...rootPaths].sort()) {
    await removeIsolatedDirectoryGeneration(rootPath, deps);
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
  await removeIsolatedDirectoryGenerationNow(rootPath);
}

async function deleteIsolatedGenerationWithBoundHelper(
  journal: IsolatedDirectoryCleanupJournal,
  deps: IsolatedDirectoryRemovalDeps,
): Promise<void> {
  const token = randomUUID();
  const sourceWorker = fileURLToPath(import.meta.url).endsWith(".ts");
  const workerPath = fileURLToPath(
    new URL(
      sourceWorker
        ? "./filesystemLockDirectoryRemovalWorker.ts"
        : "./filesystemLockDirectoryRemovalWorker.js",
      import.meta.url,
    ),
  );
  const workerArgs = sourceWorker
    ? ["--import", import.meta.resolve("tsx"), workerPath, token]
    : [workerPath, token];
  const child = spawn(process.execPath, workerArgs, {
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
    const attestation = parseDirectoryRemovalMessage(
      await readRemovalHelperLine(
        iterator,
        earlyExitMessage,
        REMOVAL_HELPER_ATTESTATION_TIMEOUT_MS,
      ),
    );
    if (
      attestation.type !== "attested" ||
      attestation.token !== token ||
      !samePhysicalDirectoryIdentity(attestation.rootIdentity, journal.rootIdentity) ||
      !samePhysicalDirectoryIdentity(attestation.generationIdentity, journal.generationIdentity)
    ) {
      throw new Error(`Bound removal helper attested the wrong generation at ${journal.rootPath}`);
    }
    const generationPath = path.join(journal.rootPath, journal.generationName);
    if (
      deps.verifyGenerationForRemoval &&
      !(await deps.verifyGenerationForRemoval(generationPath))
    ) {
      throw new Error(
        `Isolated cleanup generation identity changed or is not proven safe to remove at ${generationPath}; cleanup remains pending`,
      );
    }
    await deps.afterChildAttestation?.(journal.rootPath);
    // Arm the read before releasing the helper so a fast deletion cannot close stdout first.
    const completionLinePromise = readRemovalHelperLine(iterator, earlyExitMessage);
    child.stdin.end(encodeDirectoryRemovalMessage({ type: "go", token }));

    const completion = parseDirectoryRemovalMessage(await completionLinePromise);
    if (completion.type !== "completed" || completion.token !== token) {
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
  const rootIdentity = parsePhysicalDirectoryIdentity(value.rootIdentity);
  const generationIdentity = parsePhysicalDirectoryIdentity(value.generationIdentity);
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
  const rootIdentity = parsePhysicalDirectoryIdentity(value.rootIdentity);
  const generationIdentity = parsePhysicalDirectoryIdentity(value.generationIdentity);
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

async function inspectIsolatedDirectoryIdentity(
  directoryPath: string,
  expected: IsolatedDirectoryIdentity,
): Promise<"matches" | "missing" | "changed"> {
  let current: IsolatedDirectoryIdentity;
  try {
    current = await capturePhysicalDirectoryIdentity(directoryPath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return "missing";
    return "changed";
  }
  return samePhysicalDirectoryIdentity(current, expected) ? "matches" : "changed";
}

function assertCleanupCompletionMatchesJournal(
  completion: IsolatedDirectoryCleanupCompletion,
  journal: IsolatedDirectoryCleanupJournal,
): void {
  if (
    completion.journalNonce !== journal.journalNonce ||
    completion.rootPath !== journal.rootPath ||
    completion.platform !== journal.platform ||
    !samePhysicalDirectoryIdentity(completion.rootIdentity, journal.rootIdentity) ||
    !samePhysicalDirectoryIdentity(completion.generationIdentity, journal.generationIdentity)
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
