import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { getOracleHomeDir } from "../oracleHome.js";
import type { SessionArtifact, SessionArtifactFileIdentity } from "../sessionManager.js";
import { isDeepResearchIncompleteText } from "./deepResearchResult.js";
import type { BrowserArtifactWriteAuthority, BrowserLogger } from "./types.js";
import {
  establishWindowsPrivateDirectory,
  initializeWindowsPrivateFile,
  verifyWindowsPrivateFile,
} from "../remote/windowsPrivateTreeAcl.js";

const ARTIFACTS_DIRNAME = "artifacts";
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_EMPTY_ARCHIVE_LENGTH = 22;
const ZIP_MAX_EOCD_COMMENT_BYTES = 65_535;
type ArtifactValidation = NonNullable<SessionArtifact["validation"]>;

function sanitizePathSegment(value: string, fallback: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return sanitized || fallback;
}

export function sanitizeArtifactFilename(value: string, fallback = "artifact.bin"): string {
  const normalized = String(value ?? "")
    .replace(/\0/g, "")
    .replace(/\\/g, "/");
  const basename = path.basename(normalized).replace(/\.crdownload$/i, "");
  const fallbackName = path.basename(fallback.replace(/\\/g, "/")) || "artifact.bin";
  const sanitized = sanitizePathSegment(
    basename,
    sanitizePathSegment(fallbackName, "artifact.bin"),
  );
  return sanitized === "." || sanitized === ".."
    ? sanitizePathSegment(fallbackName, "artifact.bin")
    : sanitized;
}

export function sanitizeArtifactMimeType(value?: string): string | undefined {
  const mime = String(value ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    !mime ||
    mime.length > 127 ||
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime)
  ) {
    return undefined;
  }
  return mime;
}

function normalizeSessionId(sessionId: string): string {
  return sanitizePathSegment(path.basename(sessionId), "session");
}

export function resolveSessionArtifactsDir(sessionId: string): string {
  return path.join(
    getOracleHomeDir(),
    "sessions",
    normalizeSessionId(sessionId),
    ARTIFACTS_DIRNAME,
  );
}

function resolveArtifactWriteDirectory(params: {
  sessionId?: string;
  artifactWriteAuthority?: BrowserArtifactWriteAuthority;
}): string | null {
  if (params.artifactWriteAuthority) {
    const directory = params.artifactWriteAuthority.artifactsDirectory;
    if (!path.isAbsolute(directory)) {
      throw new Error("Browser artifact write authority must use an absolute directory");
    }
    return path.normalize(directory);
  }
  return params.sessionId ? resolveSessionArtifactsDir(params.sessionId) : null;
}

async function openExclusiveArtifact(
  basePath: string,
  windowsPrivateFiles: boolean,
): Promise<{
  handle: FileHandle;
  targetPath: string;
  createdIdentity?: SessionArtifactFileIdentity;
}> {
  const ext = path.extname(basePath);
  const stem = ext ? path.basename(basePath, ext) : path.basename(basePath);
  const dir = path.dirname(basePath);
  for (let suffix = 1; ; suffix += 1) {
    const targetPath = suffix === 1 ? basePath : path.join(dir, `${stem}-${suffix}${ext}`);
    if (windowsPrivateFiles) {
      if (!(await initializeWindowsPrivateFile(targetPath))) continue;
      let handle: FileHandle | undefined;
      let createdIdentity: SessionArtifactFileIdentity | undefined;
      try {
        const createdStat = await fs.lstat(targetPath, { bigint: true });
        if (
          createdStat.isSymbolicLink() ||
          !createdStat.isFile() ||
          createdStat.nlink !== 1n ||
          createdStat.size !== 0n
        ) {
          throw new Error(
            "Windows private browser artifact was not created as an empty regular file",
          );
        }
        createdIdentity = fileIdentityFromStat(createdStat);
        handle = await fs.open(targetPath, "r+");
        await assertOpenArtifactIdentity(handle, targetPath, createdIdentity);
        await verifyWindowsPrivateFile(targetPath);
        await assertOpenArtifactIdentity(handle, targetPath, createdIdentity);
        return { handle, targetPath, createdIdentity };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (createdIdentity) await removeExactArtifactPath(targetPath, createdIdentity);
        throw error;
      }
    }
    try {
      return { handle: await fs.open(targetPath, "wx+", 0o600), targetPath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

function fileIdentityFromStat(fileStat: {
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
  ctimeNs: bigint;
}): SessionArtifactFileIdentity {
  return {
    device: fileStat.dev.toString(),
    inode: fileStat.ino.toString(),
    birthtimeNs: fileStat.birthtimeNs.toString(),
    ctimeNs: fileStat.ctimeNs.toString(),
  };
}

function sameStableFileIdentity(
  left: SessionArtifactFileIdentity,
  right: SessionArtifactFileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

async function assertOpenArtifactIdentity(
  handle: FileHandle,
  targetPath: string,
  expectedIdentity: SessionArtifactFileIdentity,
): Promise<void> {
  const [openStat, pathStat] = await Promise.all([
    handle.stat({ bigint: true }),
    fs.lstat(targetPath, { bigint: true }),
  ]);
  if (
    !openStat.isFile() ||
    openStat.nlink !== 1n ||
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    pathStat.nlink !== 1n ||
    !sameStableFileIdentity(fileIdentityFromStat(openStat), expectedIdentity) ||
    !sameStableFileIdentity(fileIdentityFromStat(pathStat), expectedIdentity)
  ) {
    throw new Error("Windows private browser artifact physical identity changed");
  }
}

async function removeExactArtifactPath(
  targetPath: string,
  expectedIdentity: SessionArtifactFileIdentity,
): Promise<void> {
  const current = await fs.lstat(targetPath, { bigint: true }).catch(() => null);
  if (
    current &&
    !current.isSymbolicLink() &&
    current.isFile() &&
    sameStableFileIdentity(fileIdentityFromStat(current), expectedIdentity)
  ) {
    await fs.rm(targetPath, { force: true }).catch(() => undefined);
  }
}

async function writeExclusiveArtifact(
  basePath: string,
  contents: Buffer,
  windowsPrivateFiles = false,
) {
  const { handle, targetPath, createdIdentity } = await openExclusiveArtifact(
    basePath,
    windowsPrivateFiles,
  );
  let complete = false;
  try {
    await handle.writeFile(contents);
    await handle.sync();
    const fileStat = await handle.stat({ bigint: true });
    if (!fileStat.isFile() || fileStat.size !== BigInt(contents.length)) {
      throw new Error("Browser artifact write did not preserve exact byte size");
    }
    const fileIdentity = fileIdentityFromStat(fileStat);
    const sha256 = await computeOpenFileSha256(handle);
    const afterHashStat = await handle.stat({ bigint: true });
    if (
      afterHashStat.size !== fileStat.size ||
      !sameFileIdentity(fileIdentityFromStat(afterHashStat), fileIdentity)
    ) {
      throw new Error("Browser artifact physical identity changed during write");
    }
    if (windowsPrivateFiles) {
      await verifyWindowsPrivateFile(targetPath);
      await assertOpenArtifactIdentity(handle, targetPath, fileIdentity);
    }
    complete = true;
    return {
      targetPath,
      sizeBytes: Number(fileStat.size),
      sha256,
      fileIdentity,
    };
  } finally {
    await handle.close().catch(() => undefined);
    if (!complete) {
      if (createdIdentity) await removeExactArtifactPath(targetPath, createdIdentity);
      else await fs.rm(targetPath, { force: true }).catch(() => undefined);
    }
  }
}

async function readSizeBytes(targetPath: string): Promise<number | undefined> {
  try {
    return (await fs.stat(targetPath)).size;
  } catch {
    return undefined;
  }
}

export function computeBufferSha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function computeOpenFileSha256(handle: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

export async function readBrowserArtifactFileEvidence(targetPath: string): Promise<{
  sizeBytes: number;
  sha256: string;
  fileIdentity: SessionArtifactFileIdentity;
}> {
  const handle = await fs.open(targetPath, "r");
  try {
    const fileStat = await handle.stat({ bigint: true });
    if (!fileStat.isFile() || fileStat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Browser artifact evidence requires a bounded regular file");
    }
    const fileIdentity = fileIdentityFromStat(fileStat);
    const sha256 = await computeOpenFileSha256(handle);
    const afterHashStat = await handle.stat({ bigint: true });
    if (
      afterHashStat.size !== fileStat.size ||
      !sameFileIdentity(fileIdentityFromStat(afterHashStat), fileIdentity)
    ) {
      throw new Error("Browser artifact physical identity changed while collecting evidence");
    }
    return {
      sizeBytes: Number(fileStat.size),
      sha256,
      fileIdentity,
    };
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(
  left: SessionArtifactFileIdentity,
  right: SessionArtifactFileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export async function computeFileSha256(targetPath: string): Promise<string> {
  return (await readBrowserArtifactFileEvidence(targetPath)).sha256;
}

export function isZipArtifact(filename?: string, mimeType?: string): boolean {
  const ext = path.extname(String(filename ?? "")).toLowerCase();
  const mime = String(mimeType ?? "").toLowerCase();
  return (
    ext === ".zip" ||
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    mime.endsWith("+zip")
  );
}

export function validateZipBuffer(contents: Buffer): ArtifactValidation {
  if (contents.length < ZIP_EMPTY_ARCHIVE_LENGTH) {
    return { type: "zip", ok: false, error: "zip-too-small" };
  }

  const firstSignature = contents.readUInt32LE(0);
  if (firstSignature !== ZIP_LOCAL_FILE_HEADER_SIGNATURE && firstSignature !== ZIP_EOCD_SIGNATURE) {
    return { type: "zip", ok: false, error: "zip-magic-mismatch" };
  }

  const searchStart = Math.max(
    0,
    contents.length - ZIP_EMPTY_ARCHIVE_LENGTH - ZIP_MAX_EOCD_COMMENT_BYTES,
  );
  let eocdOffset = -1;
  for (
    let offset = contents.length - ZIP_EMPTY_ARCHIVE_LENGTH;
    offset >= searchStart;
    offset -= 1
  ) {
    if (contents.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    return { type: "zip", ok: false, error: "zip-central-directory-missing" };
  }

  const commentLength = contents.readUInt16LE(eocdOffset + 20);
  if (eocdOffset + ZIP_EMPTY_ARCHIVE_LENGTH + commentLength !== contents.length) {
    return { type: "zip", ok: false, error: "zip-eocd-size-mismatch" };
  }

  const centralDirectorySize = contents.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = contents.readUInt32LE(eocdOffset + 16);
  if (centralDirectoryOffset + centralDirectorySize > eocdOffset) {
    return { type: "zip", ok: false, error: "zip-central-directory-out-of-range" };
  }

  return { type: "zip", ok: true };
}

async function readFileWindow(
  handle: Awaited<ReturnType<typeof fs.open>>,
  length: number,
  position: number,
): Promise<Buffer | null> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(buffer, offset, length - offset, position + offset);
    if (result.bytesRead === 0) {
      return null;
    }
    offset += result.bytesRead;
  }
  return buffer;
}

export async function validateZipFile(targetPath: string): Promise<ArtifactValidation> {
  const handle = await fs.open(targetPath, "r");
  try {
    const fileStat = await handle.stat();
    if (fileStat.size < ZIP_EMPTY_ARCHIVE_LENGTH) {
      return { type: "zip", ok: false, error: "zip-too-small" };
    }

    const first = await readFileWindow(handle, 4, 0);
    if (!first) {
      return { type: "zip", ok: false, error: "zip-too-small" };
    }
    const firstSignature = first.readUInt32LE(0);
    if (
      firstSignature !== ZIP_LOCAL_FILE_HEADER_SIGNATURE &&
      firstSignature !== ZIP_EOCD_SIGNATURE
    ) {
      return { type: "zip", ok: false, error: "zip-magic-mismatch" };
    }

    const tailLength = Math.min(
      fileStat.size,
      ZIP_EMPTY_ARCHIVE_LENGTH + ZIP_MAX_EOCD_COMMENT_BYTES,
    );
    const tailStart = fileStat.size - tailLength;
    const tail = await readFileWindow(handle, tailLength, tailStart);
    if (!tail) {
      return { type: "zip", ok: false, error: "zip-central-directory-missing" };
    }

    let relativeEocdOffset = -1;
    for (let offset = tail.length - ZIP_EMPTY_ARCHIVE_LENGTH; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
        relativeEocdOffset = offset;
        break;
      }
    }
    if (relativeEocdOffset < 0) {
      return { type: "zip", ok: false, error: "zip-central-directory-missing" };
    }

    const eocdOffset = tailStart + relativeEocdOffset;
    const commentLength = tail.readUInt16LE(relativeEocdOffset + 20);
    if (eocdOffset + ZIP_EMPTY_ARCHIVE_LENGTH + commentLength !== fileStat.size) {
      return { type: "zip", ok: false, error: "zip-eocd-size-mismatch" };
    }

    const centralDirectorySize = tail.readUInt32LE(relativeEocdOffset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(relativeEocdOffset + 16);
    if (centralDirectoryOffset + centralDirectorySize > eocdOffset) {
      return { type: "zip", ok: false, error: "zip-central-directory-out-of-range" };
    }
    return { type: "zip", ok: true };
  } finally {
    await handle.close();
  }
}

export function validateArtifactBuffer(params: {
  filename?: string;
  mimeType?: string;
  contents: Buffer;
}): ArtifactValidation {
  if (isZipArtifact(params.filename, params.mimeType)) {
    return validateZipBuffer(params.contents);
  }
  return {
    type: "generic",
    ok: params.contents.length > 0,
    error: params.contents.length > 0 ? undefined : "empty-file",
  };
}

export async function validateArtifactFile(params: {
  filename?: string;
  mimeType?: string;
  path: string;
}): Promise<ArtifactValidation> {
  if (isZipArtifact(params.filename ?? path.basename(params.path), params.mimeType)) {
    return validateZipFile(params.path);
  }
  const size = await readSizeBytes(params.path);
  return {
    type: "generic",
    ok: Boolean(size && size > 0),
    error: size && size > 0 ? undefined : "empty-file",
  };
}

export async function writeTextBrowserArtifact(params: {
  sessionId?: string;
  artifactWriteAuthority?: BrowserArtifactWriteAuthority;
  kind: SessionArtifact["kind"];
  filename: string;
  contents: string;
  label?: string;
  mimeType?: string;
  sourceUrl?: string;
  logger?: BrowserLogger;
}): Promise<SessionArtifact | null> {
  const text = params.contents.trim();
  if (text.length === 0) return null;
  const dir = resolveArtifactWriteDirectory(params);
  if (!dir) return null;
  const windowsPrivateFiles = params.artifactWriteAuthority?.windowsPrivateFiles === true;
  if (windowsPrivateFiles) await establishWindowsPrivateDirectory(dir);
  else await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const filename = sanitizeArtifactFilename(params.filename, "artifact.md");
  const contents = Buffer.from(`${text}\n`, "utf8");
  const written = await writeExclusiveArtifact(
    path.join(dir, filename),
    contents,
    windowsPrivateFiles,
  );
  params.logger?.(`[browser] Saved ${params.kind} artifact to ${written.targetPath}`);
  return {
    kind: params.kind,
    path: written.targetPath,
    label: params.label,
    mimeType: params.mimeType ?? "text/markdown",
    sizeBytes: written.sizeBytes,
    sourceUrl: params.sourceUrl,
    sha256: written.sha256,
    fileIdentity: written.fileIdentity,
    validation: { type: "generic", ok: true },
    transfer: { status: "not-needed" },
    origin: { mode: "local" },
  };
}

export async function writeBinaryBrowserArtifact(params: {
  sessionId?: string;
  artifactWriteAuthority?: BrowserArtifactWriteAuthority;
  kind: SessionArtifact["kind"];
  filename: string;
  contents: Buffer;
  label?: string;
  mimeType?: string;
  sourceUrl?: string;
  logger?: BrowserLogger;
}): Promise<SessionArtifact | null> {
  if (params.contents.length === 0) return null;
  const dir = resolveArtifactWriteDirectory(params);
  if (!dir) return null;
  const windowsPrivateFiles = params.artifactWriteAuthority?.windowsPrivateFiles === true;
  if (windowsPrivateFiles) await establishWindowsPrivateDirectory(dir);
  else await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const filename = sanitizeArtifactFilename(params.filename, "artifact.bin");
  const written = await writeExclusiveArtifact(
    path.join(dir, filename),
    params.contents,
    windowsPrivateFiles,
  );
  const validation = validateArtifactBuffer({
    filename,
    mimeType: params.mimeType,
    contents: params.contents,
  });
  params.logger?.(`[browser] Saved ${params.kind} artifact to ${written.targetPath}`);
  if (validation.type === "zip" && !validation.ok) {
    params.logger?.(
      `[browser] ZIP validation failed for ${filename}: ${validation.error ?? "invalid"}`,
    );
  }
  return {
    kind: params.kind,
    path: written.targetPath,
    label: params.label,
    mimeType: params.mimeType,
    sizeBytes: written.sizeBytes,
    sourceUrl: params.sourceUrl,
    sha256: written.sha256,
    fileIdentity: written.fileIdentity,
    validation,
    transfer: { status: "not-needed" },
    origin: { mode: "local" },
  };
}

export async function saveDeepResearchReportArtifact(params: {
  sessionId?: string;
  artifactWriteAuthority?: BrowserArtifactWriteAuthority;
  reportMarkdown: string;
  conversationUrl?: string;
  logger?: BrowserLogger;
}): Promise<SessionArtifact | null> {
  const report = params.reportMarkdown.trim();
  if (report.length < 40 || isDeepResearchIncompleteText(report)) {
    return null;
  }
  return writeTextBrowserArtifact({
    sessionId: params.sessionId,
    artifactWriteAuthority: params.artifactWriteAuthority,
    kind: "deep-research-report",
    filename: "deep-research-report.md",
    contents: report,
    label: "Deep Research report",
    mimeType: "text/markdown",
    sourceUrl: params.conversationUrl,
    logger: params.logger,
  });
}

export async function saveBrowserTranscriptArtifact(params: {
  sessionId?: string;
  artifactWriteAuthority?: BrowserArtifactWriteAuthority;
  prompt: string;
  answerMarkdown: string;
  conversationUrl?: string;
  artifacts?: SessionArtifact[];
  logger?: BrowserLogger;
}): Promise<SessionArtifact | null> {
  const answer = params.answerMarkdown.trim();
  if (!answer) {
    return null;
  }
  const artifactLines =
    params.artifacts && params.artifacts.length > 0
      ? [
          "",
          "## Artifacts",
          "",
          ...params.artifacts.map((artifact) => {
            const label = artifact.label ?? artifact.kind;
            const hash = artifact.sha256 ? ` sha256=${artifact.sha256}` : "";
            const transfer = artifact.transfer?.status
              ? ` transfer=${artifact.transfer.status}`
              : "";
            const validation = artifact.validation
              ? ` validation=${artifact.validation.ok ? "ok" : (artifact.validation.error ?? "failed")}`
              : "";
            return `- ${label}: ${artifact.path}${hash}${transfer}${validation}`;
          }),
        ]
      : [];
  const conversationLines = params.conversationUrl
    ? ["", `Conversation: ${params.conversationUrl}`, ""]
    : ["", ""];
  const body = [
    "# Oracle Browser Transcript",
    ...conversationLines,
    "## Prompt",
    "",
    params.prompt.trim(),
    "",
    "## Answer",
    "",
    answer,
    ...artifactLines,
  ].join("\n");
  return writeTextBrowserArtifact({
    sessionId: params.sessionId,
    artifactWriteAuthority: params.artifactWriteAuthority,
    kind: "transcript",
    filename: "transcript.md",
    contents: body,
    label: "Browser transcript",
    mimeType: "text/markdown",
    sourceUrl: params.conversationUrl,
    logger: params.logger,
  });
}

export function appendArtifacts(
  existing: SessionArtifact[] | undefined,
  additions: Array<SessionArtifact | null | undefined>,
): SessionArtifact[] | undefined {
  const merged = new Map<string, SessionArtifact>();
  for (const artifact of existing ?? []) {
    merged.set(`${artifact.kind}:${artifact.path}`, artifact);
  }
  for (const artifact of additions) {
    if (artifact) {
      merged.set(`${artifact.kind}:${artifact.path}`, artifact);
    }
  }
  const values = Array.from(merged.values());
  return values.length > 0 ? values : undefined;
}

export const __test__ = {
  normalizeSessionId,
  sanitizeArtifactFilename,
  sanitizePathSegment,
};
