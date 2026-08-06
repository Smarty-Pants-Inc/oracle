import path from "node:path";
import { inferAttachRunningBrowserFamily } from "./detect.js";
import {
  CHROME_LAUNCH_CLAIM_FLAG,
  parseChromeProcessLaunchClaim,
  type ChromeProcessLaunchClaim,
} from "./chromeProcessLaunchClaim.js";
import { sameProfileDirectoryPath } from "./profileDirectoryAuthority.js";

export interface RunningChromeProcessCommand {
  readonly pid: number;
  readonly commandLine: string;
}

export interface ChromeProcessSnapshot {
  readonly pid: number;
  readonly processStartTime: string;
  readonly executablePath: string;
  readonly commandLine: string;
  readonly commandTokens?: readonly string[];
}

export function parsePosixProcessCommandLine(line: string): RunningChromeProcessCommand | null {
  const match = line.match(/^\s*(\d+)\s+(.+)$/u);
  if (!match) return null;
  const pid = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, commandLine: match[2] ?? "" };
}

export function parsePosixProcessCommands(
  processList: string,
): readonly RunningChromeProcessCommand[] {
  const processes: RunningChromeProcessCommand[] = [];
  for (const line of processList.split("\n")) {
    if (!line.trim()) continue;
    const processCommand = parsePosixProcessCommandLine(line);
    if (!processCommand) throw new Error("POSIX process enumeration was incomplete");
    processes.push(processCommand);
  }
  return processes;
}

export function parseWindowsProcessCommands(
  processList: string,
): readonly RunningChromeProcessCommand[] {
  const processes: RunningChromeProcessCommand[] = [];
  for (const line of processList.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = line.match(/^(\d+):([A-Za-z0-9+/=]*)$/u);
    if (!match) throw new Error("Windows Chrome process enumeration was incomplete");
    const pid = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error("Windows Chrome process enumeration returned an invalid pid");
    }
    processes.push({
      pid,
      commandLine: Buffer.from(match[2] ?? "", "base64").toString("utf8"),
    });
  }
  return processes;
}

export function tokenizeCommandLine(command: string): string[] | null {
  const tokens: string[] = [];
  let token = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of command.trim()) {
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        token += character;
      }
      started = true;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      continue;
    }
    token += character;
    started = true;
  }
  if (quote) return null;
  if (started) tokens.push(token);
  return tokens;
}

export function normalizeProfileArgument(value: string, platform: NodeJS.Platform): string | null {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(value)) return null;
  const normalized = pathApi.resolve(value);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function normalizeExecutablePath(value: string, platform: NodeJS.Platform): string | null {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const trimmed = value.trim();
  if (!pathApi.isAbsolute(trimmed)) return null;
  const normalized = pathApi.resolve(trimmed);
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isChromeExecutablePath(value: string, platform: NodeJS.Platform): boolean {
  const normalized = normalizeExecutablePath(value, platform);
  if (!normalized) return false;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const basename = pathApi.basename(normalized).toLowerCase();
  switch (inferAttachRunningBrowserFamily(basename)) {
    case "chrome":
      return /^(?:(?:google[ -])?chrome)(?:(?:[ -](?:stable|beta|unstable|canary))|(?:[ -]helper(?: \((?:renderer|gpu|plugin)\))?))?(?:\.exe)?$/u.test(
        basename,
      );
    case "chromium":
      return /^chromium(?:(?:[ -]browser)|(?:[ -]helper(?: \((?:renderer|gpu|plugin)\))?))?(?:\.exe)?$/u.test(
        basename,
      );
    case "edge":
      return /^(?:microsoft[ -]edge|msedge)(?:(?:[ -](?:stable|beta|dev|canary))|(?:[ -]helper(?: \((?:renderer|gpu|plugin)\))?))?(?:\.exe)?$/u.test(
        basename,
      );
    case "brave":
      return /^brave(?:[ -]browser)?(?:(?:[ -](?:stable|beta|nightly))|(?:[ -]helper(?: \((?:renderer|gpu|plugin)\))?))?(?:\.exe)?$/u.test(
        basename,
      );
    default:
      return false;
  }
}

export function isChromeExecutablePrefix(
  tokens: readonly string[],
  platform: NodeJS.Platform,
): boolean {
  const firstFlagIndex = tokens.findIndex((token) => token.startsWith("--"));
  if (firstFlagIndex <= 0) return false;
  return isChromeExecutablePath(tokens.slice(0, firstFlagIndex).join(" "), platform);
}

export function readChromeUserDataDirArgument(
  tokens: readonly string[],
  platform: NodeJS.Platform,
): string | null | undefined {
  const profileArguments: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const lower = token.toLowerCase();
    if (lower === "--user-data-dir") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return null;
      profileArguments.push(value);
      index += 1;
    } else if (lower.startsWith("--user-data-dir=")) {
      profileArguments.push(token.slice(token.indexOf("=") + 1));
    }
  }
  if (profileArguments.length === 0) return undefined;
  if (profileArguments.length !== 1) return null;
  return normalizeProfileArgument(profileArguments[0] ?? "", platform);
}

export function readDarwinChromeUserDataDirArgument(command: string): string | null | undefined {
  const flag = "--user-data-dir";
  const lowerCommand = command.toLowerCase();
  const flagOffsets: number[] = [];
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    const following = command[index + flag.length];
    if (
      (index === 0 || /\s/u.test(command[index - 1] ?? "")) &&
      lowerCommand.startsWith(flag, index) &&
      (following === undefined || following === "=" || /\s/u.test(following))
    ) {
      flagOffsets.push(index);
    }
  }
  if (flagOffsets.length === 0) return undefined;
  if (flagOffsets.length !== 1) return null;
  const flagOffset = flagOffsets[0] ?? -1;
  let valueOffset = flagOffset + flag.length;
  if (command[valueOffset] === "=") {
    valueOffset += 1;
  } else {
    while (/\s/u.test(command[valueOffset] ?? "")) valueOffset += 1;
  }
  const remainder = command.slice(valueOffset).trim();
  if (remainder.startsWith('"') || remainder.startsWith("'")) {
    const tokens = tokenizeCommandLine(command);
    return tokens ? readChromeUserDataDirArgument(tokens, "darwin") : null;
  }
  if (!remainder) return null;
  const nextFlagOffset = remainder.search(/\s--[a-z0-9][a-z0-9-]*(?=$|=|\s)/iu);
  const value = (nextFlagOffset < 0 ? remainder : remainder.slice(0, nextFlagOffset)).trim();
  if (!value) return null;
  return normalizeProfileArgument(value, "darwin");
}

export function isChromeCommandTokensForUserDataDir(
  tokens: readonly string[],
  userDataDir: string,
  platform: NodeJS.Platform,
): boolean {
  if (!isChromeExecutablePath(tokens[0] ?? "", platform)) return false;
  const expected = normalizeProfileArgument(userDataDir, platform);
  const actual = readChromeUserDataDirArgument(tokens, platform);
  return (
    expected !== null &&
    actual !== null &&
    actual !== undefined &&
    sameProfileDirectoryPath(actual, expected, platform)
  );
}

export function isChromeCommandForUserDataDir(
  command: string | null,
  userDataDir: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!command) return false;
  const tokens = tokenizeCommandLine(command);
  if (!tokens || !isChromeExecutablePrefix(tokens, platform)) return false;
  const expected = normalizeProfileArgument(userDataDir, platform);
  const actual =
    platform === "darwin"
      ? readDarwinChromeUserDataDirArgument(command)
      : readChromeUserDataDirArgument(tokens, platform);
  return (
    expected !== null &&
    actual !== null &&
    actual !== undefined &&
    sameProfileDirectoryPath(actual, expected, platform)
  );
}

export function isChromeSnapshotForUserDataDir(
  snapshot: ChromeProcessSnapshot,
  userDataDir: string,
  platform: NodeJS.Platform,
): boolean {
  return snapshot.commandTokens
    ? isChromeCommandTokensForUserDataDir(snapshot.commandTokens, userDataDir, platform)
    : isChromeCommandForUserDataDir(snapshot.commandLine, userDataDir, platform);
}

export function readChromeProcessLaunchClaimArgument(
  tokens: readonly string[],
): ChromeProcessLaunchClaim | undefined {
  const values: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const lower = token.toLowerCase();
    if (lower === CHROME_LAUNCH_CLAIM_FLAG) {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return undefined;
      values.push(value);
      index += 1;
    } else if (lower.startsWith(`${CHROME_LAUNCH_CLAIM_FLAG}=`)) {
      values.push(token.slice(token.indexOf("=") + 1));
    }
  }
  if (values.length !== 1) return undefined;
  const parts = values[0]?.split(":") ?? [];
  if (parts.length !== 2) return undefined;
  return (
    parseChromeProcessLaunchClaim({ version: 1, generationId: parts[0], nonce: parts[1] }) ??
    undefined
  );
}

export function readChromeSnapshotLaunchClaim(
  snapshot: ChromeProcessSnapshot,
  platform: NodeJS.Platform,
): ChromeProcessLaunchClaim | undefined {
  const tokens = snapshot.commandTokens ?? tokenizeCommandLine(snapshot.commandLine);
  if (
    !tokens ||
    !(snapshot.commandTokens
      ? isChromeExecutablePath(tokens[0] ?? "", platform)
      : isChromeExecutablePrefix(tokens, platform))
  ) {
    return undefined;
  }
  return readChromeProcessLaunchClaimArgument(tokens);
}

export function hasRemoteDebuggingPortArgument(tokens: readonly string[]): boolean {
  return tokens.some((token) => {
    const lower = token.toLowerCase();
    return lower === "--remote-debugging-port" || lower.startsWith("--remote-debugging-port=");
  });
}

export function readRemoteDebuggingPortArgument(command: string): number | null {
  const tokens = tokenizeCommandLine(command);
  return tokens ? readRemoteDebuggingPortArgumentFromTokens(tokens) : null;
}

export function readRemoteDebuggingPortArgumentFromTokens(
  tokens: readonly string[],
): number | null {
  const values: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    const lower = token.toLowerCase();
    if (lower === "--remote-debugging-port") {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) return null;
      values.push(value);
      index += 1;
    } else if (lower.startsWith("--remote-debugging-port=")) {
      values.push(token.slice(token.indexOf("=") + 1));
    }
  }
  if (values.length !== 1 || !/^\d+$/u.test(values[0] ?? "")) return null;
  const port = Number.parseInt(values[0] ?? "", 10);
  return port >= 0 && port <= 65_535 ? port : null;
}

export function parseLinuxBootId(raw: string): string | null {
  const bootId = raw.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(bootId)
    ? bootId
    : null;
}

export function parseLinuxProcStat(raw: string): { pid: number; startTicks: string } | null {
  const openingParenthesis = raw.indexOf("(");
  const closingParenthesis = raw.lastIndexOf(")");
  if (openingParenthesis <= 0 || closingParenthesis <= openingParenthesis) return null;
  const pid = Number.parseInt(raw.slice(0, openingParenthesis).trim(), 10);
  const fieldsAfterCommand = raw
    .slice(closingParenthesis + 1)
    .trim()
    .split(/\s+/u);
  const startTicks = fieldsAfterCommand[19];
  if (!Number.isInteger(pid) || pid <= 0 || !startTicks || !/^\d+$/u.test(startTicks)) {
    return null;
  }
  return { pid, startTicks };
}

export function parseWindowsChromeProcessSnapshot(
  output: string,
  expectedPid: number,
): ChromeProcessSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("pid" in parsed) ||
    !("processStartTime" in parsed) ||
    !("executablePath" in parsed) ||
    !("commandLine" in parsed) ||
    parsed.pid !== expectedPid ||
    typeof parsed.processStartTime !== "string" ||
    typeof parsed.executablePath !== "string" ||
    typeof parsed.commandLine !== "string"
  ) {
    return null;
  }
  return {
    pid: expectedPid,
    processStartTime: parsed.processStartTime.trim(),
    executablePath: parsed.executablePath.trim(),
    commandLine: parsed.commandLine.trim(),
  };
}

export function parseDarwinChromeExecutablePath(output: string): string | null {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith("n")) continue;
    const candidate = line.slice(1).trim();
    if (
      normalizeExecutablePath(candidate, "darwin") &&
      isChromeExecutablePath(candidate, "darwin")
    ) {
      return candidate;
    }
  }
  return null;
}
