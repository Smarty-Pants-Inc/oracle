import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { sessionStore } from "../sessionStore.js";
import { performSessionRun } from "./sessionRunner.js";
import { getCliVersion } from "../version.js";
import { loadUserConfig } from "../config.js";
import { mapConsultToRunOptions, ensureBrowserAvailable } from "../mcp/utils.js";
import { buildConsultBrowserConfig } from "../mcp/tools/consult.js";
import { normalizeBrowserModelStrategy } from "../browser/modelStrategy.js";
import type { BrowserModelStrategy } from "../browser/types.js";
import { resolveRemoteServiceConfig } from "../remote/remoteServiceConfig.js";
import { createRemoteBrowserExecutor } from "../remote/client.js";
import type { BrowserSessionRunnerDeps } from "../browser/sessionRunner.js";
import type { BrowserSessionConfig } from "../sessionStore.js";
import type { UserConfig } from "../config.js";

export interface SupervisorPromptRequest {
  prompt: string;
  sessionSlug: string;
  model?: string;
  browserModelStrategy?: string;
  browserModelLabel?: string;
  followupSession?: string;
  files?: string[];
  cwd?: string;
}

export function buildSupervisorBrowserConfig({
  userConfig,
  env,
  runModel,
  inputModel,
  browserModelLabel,
  browserModelStrategy,
  defaultManualLoginCookieSync,
}: {
  userConfig: UserConfig;
  env: Record<string, string | undefined>;
  runModel: string;
  inputModel: string;
  browserModelLabel?: string;
  browserModelStrategy?: BrowserModelStrategy;
  defaultManualLoginCookieSync?: boolean;
}): BrowserSessionConfig {
  const browserConfig = buildConsultBrowserConfig({
    userConfig,
    env,
    runModel,
    inputModel,
    browserModelLabel,
    browserModelStrategy,
    browserKeepBrowser: true,
  });
  const profileDir =
    env.ORACLE_BROWSER_PROFILE_DIR?.trim() ||
    userConfig.browser?.manualLoginProfileDir ||
    browserConfig.manualLoginProfileDir ||
    null;
  const manualLoginCookieSync =
    userConfig.browser?.manualLoginCookieSync ??
    defaultManualLoginCookieSync ??
    process.platform === "darwin";
  browserConfig.manualLogin = true;
  browserConfig.manualLoginProfileDir = profileDir;
  browserConfig.manualLoginCookieSync = manualLoginCookieSync;
  browserConfig.cookieSync = manualLoginCookieSync;
  browserConfig.attachRunning = false;
  browserConfig.remoteChrome = null;
  if (process.platform === "darwin") {
    browserConfig.hideWindow = true;
  }
  browserConfig.keepBrowser = true;
  return browserConfig;
}

export async function runSupervisorPromptOperation(
  request: SupervisorPromptRequest,
): Promise<
  { ok: true; sessionId: string; output: string } | { ok: false; error: string; sessionId?: string }
> {
  const requestedModel = request.model?.trim() || "gpt-5.4-pro";
  let browserModelStrategy: BrowserModelStrategy = "current";
  const requestedStrategy = request.browserModelStrategy?.trim();
  if (requestedStrategy) {
    const normalized = normalizeBrowserModelStrategy(requestedStrategy);
    if (normalized) {
      browserModelStrategy = normalized;
    }
  }
  const browserModelLabel = request.browserModelLabel?.trim() || undefined;

  const { config: userConfig } = await loadUserConfig();
  const cwd = request.cwd?.trim() || process.cwd();
  const files = Array.isArray(request.files) ? request.files.filter(Boolean) : [];
  const { runOptions } = mapConsultToRunOptions({
    prompt: request.prompt,
    files,
    model: requestedModel,
    engine: "browser",
    browserAttachments: files.length > 0 ? "always" : undefined,
    userConfig,
    env: process.env,
  });
  const outputPath = path.join(
    os.tmpdir(),
    `oracle-supervisor-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
  );
  runOptions.followupSessionId = request.followupSession?.trim() || undefined;
  runOptions.renderPlain = true;
  runOptions.silent = true;
  runOptions.writeOutputPath = outputPath;

  const resolvedRemote = resolveRemoteServiceConfig({ userConfig, env: process.env });
  const browserGuard = ensureBrowserAvailable("browser", { remoteHost: resolvedRemote.host });
  if (browserGuard) {
    return { ok: false, error: browserGuard };
  }

  let browserDeps: BrowserSessionRunnerDeps | undefined;
  if (resolvedRemote.host) {
    if (!resolvedRemote.token) {
      return {
        ok: false,
        error: `Remote host configured (${resolvedRemote.host}) but remote token is missing.`,
      };
    }
    browserDeps = {
      executeBrowser: createRemoteBrowserExecutor({
        host: resolvedRemote.host,
        token: resolvedRemote.token,
      }),
    };
  }

  const browserConfig = buildSupervisorBrowserConfig({
    userConfig,
    env: process.env,
    runModel: runOptions.model,
    inputModel: requestedModel,
    browserModelLabel,
    browserModelStrategy,
    defaultManualLoginCookieSync: resolvedRemote.host ? false : process.platform === "darwin",
  });

  const sessionMeta = await sessionStore.createSession(
    {
      ...runOptions,
      mode: "browser",
      slug: request.sessionSlug,
      browserConfig,
      waitPreference: true,
    },
    cwd,
    { enabled: false, sound: false },
    request.sessionSlug,
  );
  const logWriter = sessionStore.createLogWriter(sessionMeta.id);
  const log = (line?: string): void => logWriter.logLine(line);
  const write = (chunk: string): boolean => {
    logWriter.writeChunk(chunk);
    return true;
  };

  try {
    await performSessionRun({
      sessionMeta,
      runOptions,
      mode: "browser",
      browserConfig,
      cwd,
      log,
      write,
      version: getCliVersion(),
      notifications: { enabled: false, sound: false },
      muteStdout: true,
      browserDeps,
    });
    const output = await fs.readFile(outputPath, "utf8").catch(() => "");
    return { ok: true, sessionId: sessionMeta.id, output: output.trimEnd() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: `Session ${sessionMeta.id} failed: ${message}`,
      sessionId: sessionMeta.id,
    };
  } finally {
    logWriter.stream.end();
    await fs.rm(outputPath, { force: true }).catch(() => undefined);
  }
}
