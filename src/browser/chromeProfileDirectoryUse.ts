import {
  isChromeExecutablePrefix,
  readChromeUserDataDirArgument,
  readDarwinChromeUserDataDirArgument,
  tokenizeCommandLine,
  type RunningChromeProcessCommand,
} from "./chromeProcessCommandParsing.js";
import {
  executeProcessCommand,
  listRunningChromeProcessCommands,
  type ProcessCommandExecutor,
} from "./chromeProcessProbe.js";
import {
  captureProfileDirectoryIdentity,
  parseProfileDirectoryIdentity,
  samePhysicalProfileDirectoryIdentity,
  type ProfileDirectoryIdentity,
} from "./profileDirectoryAuthority.js";
import {
  comparePlatformProcessGenerations,
  createPlatformProcessGenerationProvider,
  createTrustedProcessProbe,
  type TrustedProcessProbe,
} from "./platformProcessGeneration.js";

export interface ChromeProfileDirectoryUseCandidate {
  readonly pid: number;
  readonly processGeneration: string;
  readonly profileDirectory: ProfileDirectoryIdentity;
}

export interface ChromeProfileDirectoryUnusedProof {
  readonly status: "unused";
  readonly candidates: readonly ChromeProfileDirectoryUseCandidate[];
}

export type ChromeProfileDirectoryUseInspection =
  | ChromeProfileDirectoryUnusedProof
  | {
      readonly status: "in-use";
      readonly candidates: readonly ChromeProfileDirectoryUseCandidate[];
    }
  | {
      readonly status: "unavailable";
      readonly candidates: readonly ChromeProfileDirectoryUseCandidate[];
      readonly reason: string;
    };

export interface ChromeProfileDirectoryUseDeps {
  readonly platform?: NodeJS.Platform;
  readonly execute?: ProcessCommandExecutor;
  readonly trustedProcessProbe?: TrustedProcessProbe | null;
  readonly listProcesses?: () => Promise<readonly RunningChromeProcessCommand[]>;
  readonly readProcessGeneration?: (pid: number) => Promise<string | null>;
  readonly captureProfileIdentity?: (userDataDir: string) => Promise<ProfileDirectoryIdentity>;
}

export async function inspectChromeProfileDirectoryUse(
  expected: ProfileDirectoryIdentity,
  deps: ChromeProfileDirectoryUseDeps = {},
): Promise<ChromeProfileDirectoryUseInspection> {
  const platform = deps.platform ?? process.platform;
  const parsedExpected = parseProfileDirectoryIdentity(expected, platform);
  if (!parsedExpected || expected.platform !== platform) {
    return { status: "unavailable", candidates: [], reason: "Profile identity is invalid" };
  }
  const execute = deps.execute ?? executeProcessCommand;
  const trustedProcessProbe =
    deps.trustedProcessProbe === undefined
      ? createTrustedProcessProbe(platform, execute)
      : deps.trustedProcessProbe;
  const processGenerationProvider = createPlatformProcessGenerationProvider({
    platform,
    execute,
    trustedProcessProbe,
  });
  const readProcessGeneration =
    deps.readProcessGeneration ?? processGenerationProvider.readProcessGeneration;
  const captureProfileIdentity = deps.captureProfileIdentity ?? captureProfileDirectoryIdentity;
  let processes: readonly RunningChromeProcessCommand[];
  try {
    processes = await (deps.listProcesses
      ? deps.listProcesses()
      : listRunningChromeProcessCommands(platform, trustedProcessProbe));
  } catch {
    return {
      status: "unavailable",
      candidates: [],
      reason: "Complete Chrome process enumeration failed",
    };
  }

  const candidates: ChromeProfileDirectoryUseCandidate[] = [];
  const seenPids = new Set<number>();
  for (const processCommand of processes) {
    if (
      !Number.isInteger(processCommand.pid) ||
      processCommand.pid <= 0 ||
      typeof processCommand.commandLine !== "string" ||
      seenPids.has(processCommand.pid)
    ) {
      return {
        status: "unavailable",
        candidates,
        reason: "Chrome process enumeration returned an invalid or duplicate process",
      };
    }
    seenPids.add(processCommand.pid);
    if (!processCommand.commandLine.trim()) {
      if (platform === "win32") {
        return {
          status: "unavailable",
          candidates,
          reason: `Chrome pid ${processCommand.pid} has no readable command line`,
        };
      }
      continue;
    }
    const tokens = tokenizeCommandLine(processCommand.commandLine);
    if (!tokens) {
      if (
        platform === "win32" ||
        /\b(?:chrome|chromium|edge|brave)\b/iu.test(processCommand.commandLine)
      ) {
        return {
          status: "unavailable",
          candidates,
          reason: `Chrome pid ${processCommand.pid} has an unreadable command line`,
        };
      }
      continue;
    }
    if (!isChromeExecutablePrefix(tokens, platform)) continue;
    const userDataDir =
      platform === "darwin"
        ? readDarwinChromeUserDataDirArgument(processCommand.commandLine)
        : readChromeUserDataDirArgument(tokens, platform);
    if (userDataDir === undefined) continue;
    if (userDataDir === null) {
      return {
        status: "unavailable",
        candidates,
        reason: `Chrome pid ${processCommand.pid} has an invalid profile argument`,
      };
    }
    let processGeneration: string | null;
    try {
      processGeneration = await readProcessGeneration(processCommand.pid);
    } catch {
      processGeneration = null;
    }
    if (!processGeneration?.trim()) {
      return {
        status: "unavailable",
        candidates,
        reason: `Chrome pid ${processCommand.pid} has no comparable process generation`,
      };
    }
    let capturedProfile: ProfileDirectoryIdentity;
    try {
      capturedProfile = await captureProfileIdentity(userDataDir);
    } catch {
      return {
        status: "unavailable",
        candidates,
        reason: `Chrome pid ${processCommand.pid} profile identity is unreadable`,
      };
    }
    const profileDirectory = parseProfileDirectoryIdentity(capturedProfile, platform);
    let confirmedProcessGeneration: string | null;
    try {
      confirmedProcessGeneration = await readProcessGeneration(processCommand.pid);
    } catch {
      confirmedProcessGeneration = null;
    }
    if (
      !profileDirectory ||
      !confirmedProcessGeneration?.trim() ||
      comparePlatformProcessGenerations(processGeneration, confirmedProcessGeneration) !== "same"
    ) {
      return {
        status: "unavailable",
        candidates,
        reason: `Chrome pid ${processCommand.pid} changed during physical profile inspection`,
      };
    }
    candidates.push(
      Object.freeze({
        pid: processCommand.pid,
        processGeneration,
        profileDirectory,
      }),
    );
  }

  candidates.sort((left, right) => left.pid - right.pid);
  const frozenCandidates = Object.freeze(candidates);
  return frozenCandidates.some((candidate) =>
    samePhysicalProfileDirectoryIdentity(candidate.profileDirectory, parsedExpected),
  )
    ? { status: "in-use", candidates: frozenCandidates }
    : { status: "unused", candidates: frozenCandidates };
}

export async function revalidateChromeProfileDirectoryUse(
  expected: ProfileDirectoryIdentity,
  previous: ChromeProfileDirectoryUnusedProof,
  deps: ChromeProfileDirectoryUseDeps = {},
): Promise<ChromeProfileDirectoryUseInspection> {
  const current = await inspectChromeProfileDirectoryUse(expected, deps);
  if (current.status !== "unused") return current;
  const previousCandidates = new Map(
    previous.candidates.map((candidate) => [candidate.pid, candidate] as const),
  );
  for (const candidate of current.candidates) {
    const prior = previousCandidates.get(candidate.pid);
    if (
      prior &&
      comparePlatformProcessGenerations(prior.processGeneration, candidate.processGeneration) !==
        "same"
    ) {
      return {
        status: "unavailable",
        candidates: current.candidates,
        reason: `Chrome pid ${candidate.pid} changed generation during profile cleanup handoff`,
      };
    }
  }
  return current;
}

export async function isChromeUsingUserDataDir(userDataDir: string): Promise<boolean> {
  try {
    const expected = await captureProfileDirectoryIdentity(userDataDir);
    return (await inspectChromeProfileDirectoryUse(expected)).status !== "unused";
  } catch {
    return true;
  }
}
