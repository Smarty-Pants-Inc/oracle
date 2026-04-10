import type { BrowserLogger, ResolvedBrowserConfig } from "./types.js";
import {
  discoverDevToolsActivePortCandidates,
  readDevToolsActivePortInfo,
  type DevToolsActivePortCandidate,
} from "./detect.js";
import { readChromePid } from "./profileState.js";

export interface AttachRunningConnectionInfo {
  host: string;
  port: number;
  browserWSEndpoint: string;
  profileRoot: string;
  chromePid: number | null;
}

export async function resolveAttachRunningConnection(
  config: Pick<ResolvedBrowserConfig, "chromePath" | "remoteChrome"> & {
    manualLoginProfileDir?: string | null;
  },
  logger: BrowserLogger,
): Promise<AttachRunningConnectionInfo> {
  const host = config.remoteChrome?.host ?? "127.0.0.1";
  const requestedPort = config.remoteChrome?.port ?? null;
  if (config.chromePath) {
    logger("Note: --browser-chrome-path is ignored when --browser-attach-running is enabled.");
  }

  if (config.remoteChrome) {
    logger(`Using explicit attach-running target ${host}:${config.remoteChrome.port}.`);
  } else {
    logger("Using attach-running discovery for an already-open browser.");
  }

  const hintedProfileRoot = config.manualLoginProfileDir?.trim() || null;
  if (hintedProfileRoot) {
    const direct = await readDevToolsActivePortInfo(hintedProfileRoot, { host });
    if (direct) {
      logger(`Selected attach-running browser metadata from ${direct.path}`);
      return {
        host,
        port: direct.port,
        browserWSEndpoint: direct.browserWSEndpoint,
        profileRoot: hintedProfileRoot,
        chromePid: await readChromePid(hintedProfileRoot),
      };
    }
    throw new Error(
      `Attach-running was configured to use profile ${hintedProfileRoot}, but that profile does not expose a readable DevToolsActivePort file.`,
    );
  }

  const candidates = (await discoverDevToolsActivePortCandidates({ host }))
    .filter((candidate) => requestedPort === null || candidate.port === requestedPort)
    .sort(compareDevToolsCandidates);

  if (candidates.length === 0) {
    throw new Error(
      requestedPort === null
        ? `No running browser with attach metadata was found on ${host}. Enable remote debugging in chrome://inspect/#remote-debugging first.`
        : `No running browser with attach metadata matched ${host}:${requestedPort}. Enable remote debugging in chrome://inspect/#remote-debugging first.`,
    );
  }
  const candidate = candidates[0];
  logger(`Selected attach-running browser metadata from ${candidate.path}`);
  return {
    host,
    port: candidate.port,
    browserWSEndpoint: candidate.browserWSEndpoint,
    profileRoot: candidate.profileRoot,
    chromePid: await readChromePid(candidate.profileRoot),
  };
}

function compareDevToolsCandidates(
  left: DevToolsActivePortCandidate,
  right: DevToolsActivePortCandidate,
): number {
  if (right.mtimeMs !== left.mtimeMs) {
    return right.mtimeMs - left.mtimeMs;
  }
  return left.path.localeCompare(right.path);
}
