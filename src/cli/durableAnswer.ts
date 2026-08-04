import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { open, readFile, rename, rm, mkdir } from "node:fs/promises";
import type { SessionArtifact } from "../sessionStore.js";
import { sessionStore } from "../sessionStore.js";

export interface DurableBrowserAnswerReceipt {
  artifact: SessionArtifact;
  sha256: string;
  sizeBytes: number;
}

export interface PersistDurableBrowserAnswerOptions {
  sessionId: string;
  answer: string;
  logHeader?: string;
  replaceLog?: boolean;
}

export async function persistDurableBrowserAnswer(
  options: PersistDurableBrowserAnswerOptions,
): Promise<DurableBrowserAnswerReceipt> {
  if (!options.answer.trim()) {
    throw new Error("Cannot persist an empty browser answer");
  }
  const payload = Buffer.from(options.answer, "utf8");
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const paths = await sessionStore.getPaths(options.sessionId);
  const artifactsDir = path.join(paths.dir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  await syncDirectory(paths.dir);
  const answerPath = path.join(artifactsDir, `browser-answer-${sha256}.md`);
  await ensureDurableFile(answerPath, payload);

  if (options.logHeader) {
    const logPayload = Buffer.from(`${options.logHeader}\nAnswer:\n${options.answer}\n`, "utf8");
    if (options.replaceLog) {
      await writeDurableFile(paths.log, logPayload);
    } else {
      await appendDurableFile(paths.log, logPayload);
    }
  }

  const verified = await readFile(answerPath);
  const verifiedSha256 = createHash("sha256").update(verified).digest("hex");
  if (!verified.equals(payload) || verifiedSha256 !== sha256) {
    throw new Error(`Durable browser answer verification failed: ${answerPath}`);
  }
  return {
    artifact: {
      kind: "transcript",
      path: answerPath,
      label: "Durable browser answer",
      mimeType: "text/markdown",
      sizeBytes: verified.byteLength,
      sha256,
      validation: { type: "generic", ok: true },
      transfer: { status: "not-needed" },
      origin: { mode: "local" },
    },
    sha256,
    sizeBytes: verified.byteLength,
  };
}

async function ensureDurableFile(targetPath: string, payload: Buffer): Promise<void> {
  try {
    const existing = await readFile(targetPath);
    if (existing.equals(payload)) return;
    throw new Error(`Durable browser answer hash collision: ${targetPath}`);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
  }
  await writeDurableFile(targetPath, payload);
}

async function writeDurableFile(targetPath: string, payload: Buffer): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tempPath, targetPath);
    await syncDirectory(path.dirname(targetPath));
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
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

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function readErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
