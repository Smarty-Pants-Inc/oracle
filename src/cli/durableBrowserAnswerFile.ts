import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import type { SessionArtifact } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";
import { readErrorCode, syncDirectory } from "../fsDurability.js";
import { writeFileAtomicDurable } from "../sessionManager.js";

export interface DurableBrowserAnswerReceipt {
  artifact: SessionArtifact;
}

export interface PersistDurableBrowserAnswerOptions {
  sessionId: string;
  answer: string;
  logHeader?: string;
  replaceLog?: boolean;
}

export async function persistDurableBrowserAnswer(
  options: PersistDurableBrowserAnswerOptions,
  expectedReceipt?: DurableBrowserAnswerReceipt,
): Promise<DurableBrowserAnswerReceipt> {
  const prepared = await prepareDurableBrowserAnswer(options);
  if (expectedReceipt) assertDurableBrowserAnswerReceipt(prepared.receipt, expectedReceipt);

  await mkdir(path.dirname(prepared.receipt.artifact.path), { recursive: true });
  await syncDirectory(prepared.paths.dir);
  await ensureDurableBrowserAnswerFile(prepared.receipt.artifact.path, prepared.payload);

  if (options.logHeader) {
    const logPayload = Buffer.from(`${options.logHeader}\nAnswer:\n${options.answer}\n`, "utf8");
    if (options.replaceLog) {
      await writeFileAtomicDurable(prepared.paths.log, logPayload);
    } else {
      await appendDurableFile(prepared.paths.log, logPayload);
    }
  }

  return expectedReceipt ?? prepared.receipt;
}

export async function readDurableBrowserAnswer(
  receipt: DurableBrowserAnswerReceipt,
): Promise<string | null> {
  const targetPath = receipt.artifact.path;
  let entry: Stats;
  try {
    entry = await lstat(targetPath);
  } catch (error) {
    if (readErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  if (!entry.isFile()) {
    throw new Error(`Durable browser answer is not a regular file: ${targetPath}`);
  }

  const handle = await open(targetPath, "r");
  try {
    const before = await handle.stat();
    if (!isUnchangedFile(entry, before)) {
      throw new Error(`Durable browser answer path changed during recovery: ${targetPath}`);
    }
    const payload = await handle.readFile();
    const afterRead = await handle.stat();
    if (!isUnchangedFile(before, afterRead)) {
      throw new Error(`Durable browser answer changed during recovery: ${targetPath}`);
    }
    const sha256 = createHash("sha256").update(payload).digest("hex");
    if (payload.byteLength !== receipt.artifact.sizeBytes || sha256 !== receipt.artifact.sha256) {
      throw new Error(`Durable browser answer receipt mismatch: ${targetPath}`);
    }
    const named = await lstat(targetPath);
    if (!isUnchangedFile(afterRead, named)) {
      throw new Error(`Durable browser answer path changed during recovery: ${targetPath}`);
    }
    return payload.toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function prepareDurableBrowserAnswer(options: PersistDurableBrowserAnswerOptions) {
  if (!options.answer.trim()) {
    throw new Error("Cannot persist an empty browser answer");
  }
  const payload = Buffer.from(options.answer, "utf8");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const paths = await sessionStore.getPaths(options.sessionId);
  const answerPath = path.join(paths.dir, "artifacts", `browser-answer-${sha256}.md`);
  const receipt: DurableBrowserAnswerReceipt = {
    artifact: {
      kind: "transcript",
      path: answerPath,
      label: "Durable browser answer",
      mimeType: "text/markdown",
      sizeBytes: payload.byteLength,
      sha256,
      validation: { type: "generic", ok: true },
      transfer: { status: "not-needed" },
      origin: { mode: "local" },
    },
  };
  return { paths, payload, receipt };
}

export function assertDurableBrowserAnswerReceipt(
  actual: DurableBrowserAnswerReceipt,
  expected: DurableBrowserAnswerReceipt,
): void {
  if (
    actual.artifact.kind !== expected.artifact.kind ||
    actual.artifact.path !== expected.artifact.path ||
    actual.artifact.sha256 !== expected.artifact.sha256 ||
    actual.artifact.sizeBytes !== expected.artifact.sizeBytes
  ) {
    throw new Error("Durable browser answer receipt does not match its publication intent");
  }
}

export async function ensureDurableBrowserAnswerFile(
  targetPath: string,
  payload: Buffer,
): Promise<void> {
  let entry: Stats;
  try {
    entry = await lstat(targetPath);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
    await writeFileAtomicDurable(targetPath, payload);
    entry = await lstat(targetPath);
  }
  if (!entry.isFile()) {
    throw new Error(`Durable browser answer is not a regular file: ${targetPath}`);
  }

  const handle = await open(targetPath, "r+");
  try {
    const before = await handle.stat();
    if (!isUnchangedFile(entry, before)) {
      throw new Error(`Durable browser answer path changed during verification: ${targetPath}`);
    }
    const existing = await handle.readFile();
    const afterRead = await handle.stat();
    if (!isUnchangedFile(before, afterRead)) {
      throw new Error(`Durable browser answer changed during verification: ${targetPath}`);
    }
    if (!existing.equals(payload)) {
      throw new Error(`Durable browser answer hash collision: ${targetPath}`);
    }
    await handle.sync();
    const afterSync = await handle.stat();
    if (!isUnchangedFile(before, afterSync)) {
      throw new Error(`Durable browser answer changed during verification: ${targetPath}`);
    }
    await syncDirectory(path.dirname(targetPath));
    const named = await lstat(targetPath);
    if (!isUnchangedFile(afterSync, named)) {
      throw new Error(`Durable browser answer path changed during verification: ${targetPath}`);
    }
  } finally {
    await handle.close();
  }
}

function isUnchangedFile(
  before: { dev: number; ino: number; size: number; mtimeMs: number },
  after: { dev: number; ino: number; size: number; mtimeMs: number },
): boolean {
  return (
    after.dev === before.dev &&
    after.ino === before.ino &&
    after.size === before.size &&
    after.mtimeMs === before.mtimeMs
  );
}

async function appendDurableFile(targetPath: string, payload: Buffer): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const handle = await open(targetPath, "a", 0o600);
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
