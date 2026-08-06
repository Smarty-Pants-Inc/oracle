import {
  hasRemoteDebuggingPortArgument,
  isChromeCommandForUserDataDir,
  parsePosixProcessCommandLine,
  parsePosixProcessCommands,
  readChromeProcessLaunchClaimArgument,
  readRemoteDebuggingPortArgument,
  readRemoteDebuggingPortArgumentFromTokens,
  tokenizeCommandLine,
  type RunningChromeProcessCommand,
} from "./chromeProcessCommandParsing.js";
import {
  parseChromeProcessLaunchClaim,
  sameChromeProcessLaunchClaim,
  type ChromeProcessLaunchClaim,
} from "./chromeProcessLaunchClaim.js";
import { executeProcessCommand, listRunningChromeProcessCommands } from "./chromeProcessProbe.js";
import { createTrustedProcessProbe } from "./platformProcessGeneration.js";
import { readDevToolsPort } from "./profileDevToolsState.js";

export interface RunningChromeDebugTarget {
  readonly pid: number;
  readonly port: number;
}

export interface RunningClaimedChromeProcess {
  readonly pid: number;
  readonly port: number | null;
}

export interface ChromeLaunchClaimProcessDiscovery {
  readonly exactMatches: readonly RunningClaimedChromeProcess[];
  readonly conflictingProfilePids: readonly number[];
}

export async function inspectRunningChromeProcessesForLaunchClaim(
  userDataDir: string,
  claim: ChromeProcessLaunchClaim,
): Promise<ChromeLaunchClaimProcessDiscovery> {
  const validated = parseChromeProcessLaunchClaim(claim);
  if (!validated) throw new Error("Chrome launch claim is invalid");
  const platform = process.platform;
  const trustedProcessProbe = createTrustedProcessProbe(platform, executeProcessCommand);
  const [activePort, processes] = await Promise.all([
    readDevToolsPort(userDataDir),
    listRunningChromeProcessCommands(platform, trustedProcessProbe),
  ]);
  return inspectChromeProcessesForLaunchClaim(
    processes,
    userDataDir,
    validated,
    activePort,
    platform,
  );
}

export async function findRunningChromeDebugTargetForProfile(
  userDataDir: string,
): Promise<RunningChromeDebugTarget | null> {
  if (process.platform === "win32") return null;
  const trustedProcessProbe = createTrustedProcessProbe(process.platform, executeProcessCommand);
  if (!trustedProcessProbe) return null;
  try {
    const [activePort, { stdout }] = await Promise.all([
      readDevToolsPort(userDataDir),
      trustedProcessProbe(["-ax", "-o", "pid=", "-o", "command="]),
    ]);
    return findChromeDebugTargetForProfileFromProcessList(
      stdout,
      userDataDir,
      activePort,
      process.platform,
    );
  } catch {
    return null;
  }
}

export async function findRunningChromeProcessForProfile(
  userDataDir: string,
  expectedDebugPortArgument: number,
  expectedPid?: number,
  expectedLaunchClaim?: ChromeProcessLaunchClaim,
): Promise<{ pid: number } | null> {
  if (process.platform === "win32") return null;
  const trustedProcessProbe = createTrustedProcessProbe(process.platform, executeProcessCommand);
  if (!trustedProcessProbe) return null;
  try {
    const { stdout } = await trustedProcessProbe(["-ax", "-o", "pid=", "-o", "command="]);
    for (const line of stdout.split("\n")) {
      const processCommand = parsePosixProcessCommandLine(line);
      if (!processCommand) continue;
      const { pid, commandLine } = processCommand;
      if (expectedPid && pid !== expectedPid) continue;
      const tokens = tokenizeCommandLine(commandLine);
      if (!tokens || !isChromeCommandForUserDataDir(commandLine, userDataDir, process.platform)) {
        continue;
      }
      if (
        expectedLaunchClaim &&
        !sameChromeProcessLaunchClaim(
          readChromeProcessLaunchClaimArgument(tokens),
          expectedLaunchClaim,
        )
      ) {
        continue;
      }
      if (readRemoteDebuggingPortArgumentFromTokens(tokens) !== expectedDebugPortArgument) continue;
      return { pid };
    }
    return null;
  } catch {
    return null;
  }
}

export function findChromeDebugTargetForProfileFromProcessList(
  processList: string,
  userDataDir: string,
  activePort: number | null = null,
  platform: NodeJS.Platform = process.platform,
): RunningChromeDebugTarget | null {
  for (const line of processList.split("\n")) {
    const processCommand = parsePosixProcessCommandLine(line);
    if (!processCommand) continue;
    if (!isChromeCommandForUserDataDir(processCommand.commandLine, userDataDir, platform)) continue;
    const configuredPort = readRemoteDebuggingPortArgument(processCommand.commandLine);
    const port = configuredPort === 0 ? activePort : configuredPort;
    if (!port || port <= 0) continue;
    return { pid: processCommand.pid, port };
  }
  return null;
}

export function inspectChromeProcessesForLaunchClaimFromProcessList(
  processList: string,
  userDataDir: string,
  claim: ChromeProcessLaunchClaim,
  activePort: number | null = null,
  platform: NodeJS.Platform = process.platform,
): ChromeLaunchClaimProcessDiscovery {
  const validated = parseChromeProcessLaunchClaim(claim);
  if (!validated) return { exactMatches: [], conflictingProfilePids: [] };
  return inspectChromeProcessesForLaunchClaim(
    parsePosixProcessCommands(processList),
    userDataDir,
    validated,
    activePort,
    platform,
  );
}

function inspectChromeProcessesForLaunchClaim(
  processes: readonly RunningChromeProcessCommand[],
  userDataDir: string,
  claim: ChromeProcessLaunchClaim,
  activePort: number | null,
  platform: NodeJS.Platform,
): ChromeLaunchClaimProcessDiscovery {
  const exactMatches = new Map<number, RunningClaimedChromeProcess>();
  const conflictingProfilePids = new Set<number>();
  for (const processCommand of processes) {
    const tokens = tokenizeCommandLine(processCommand.commandLine);
    if (
      !tokens ||
      !isChromeCommandForUserDataDir(processCommand.commandLine, userDataDir, platform) ||
      !hasRemoteDebuggingPortArgument(tokens)
    ) {
      continue;
    }
    if (!sameChromeProcessLaunchClaim(readChromeProcessLaunchClaimArgument(tokens), claim)) {
      conflictingProfilePids.add(processCommand.pid);
      continue;
    }
    const configuredPort = readRemoteDebuggingPortArgumentFromTokens(tokens);
    const resolvedPort = configuredPort === 0 ? activePort : configuredPort;
    const port = resolvedPort && resolvedPort > 0 && resolvedPort <= 65_535 ? resolvedPort : null;
    exactMatches.set(processCommand.pid, { pid: processCommand.pid, port });
  }
  return {
    exactMatches: [...exactMatches.values()].sort((left, right) => left.pid - right.pid),
    conflictingProfilePids: [...conflictingProfilePids].sort((left, right) => left - right),
  };
}
