import process from "node:process";
import readline from "node:readline";
import type { LaunchedChrome } from "chrome-launcher";
import {
  attachSupervisorThread,
  listSupervisorThreads,
  newSupervisorThread,
  supervisorThreadMatchesProjectScope,
  type SupervisorThreadInfo,
} from "../browser/supervisorThreads.js";
import {
  captureFrontmostProcess,
  hideChromeWindow,
  startChromeFocusGuard,
  finalizeChromeFocusProtection,
} from "../browser/chromeLifecycle.js";
import { sessionStore } from "../sessionStore.js";
import {
  connectSupervisorRuntime,
  resolveSupervisorRuntimeContext,
} from "./supervisorBrokerRuntime.js";
import {
  runSupervisorPromptOperation,
  type SupervisorPromptRequest,
} from "./supervisorBrokerPrompt.js";

export type SupervisorBrokerOperation =
  | "run_prompt"
  | "list_threads"
  | "new_thread"
  | "attach_thread";

export interface SupervisorBrokerRequest extends SupervisorPromptRequest {
  operation?: SupervisorBrokerOperation;
  action?: SupervisorBrokerOperation;
  conversationId?: string;
  shutdown?: boolean;
}

export type SupervisorBrokerResponse =
  | { ok: true; sessionId: string; output: string }
  | { ok: true; threads: SupervisorThreadInfo[] }
  | { ok: true; thread: SupervisorThreadInfo; sessionId: string }
  | { ok: false; error: string; sessionId?: string };

export interface SupervisorBrokerDeps {
  runPrompt?: (
    request: SupervisorPromptRequest,
  ) => Promise<
    | { ok: true; sessionId: string; output: string }
    | { ok: false; error: string; sessionId?: string }
  >;
  listThreads?: (
    request: SupervisorBrokerRequest,
  ) => Promise<{ ok: true; threads: SupervisorThreadInfo[] }>;
  newThread?: (
    request: SupervisorBrokerRequest,
  ) => Promise<{ ok: true; thread: SupervisorThreadInfo; sessionId: string }>;
  attachThread?: (
    request: SupervisorBrokerRequest,
  ) => Promise<{ ok: true; thread: SupervisorThreadInfo; sessionId: string }>;
}

const supervisorChromeLogger = Object.assign((_: string) => {}, { verbose: false });
interface ChromeFocusDeps {
  captureFrontmostProcess: typeof captureFrontmostProcess;
  hideChromeWindow: typeof hideChromeWindow;
  startChromeFocusGuard: typeof startChromeFocusGuard;
  finalizeChromeFocusProtection: typeof finalizeChromeFocusProtection;
}

interface SupervisorRuntimeDeps {
  resolveSupervisorRuntimeContext: typeof resolveSupervisorRuntimeContext;
  connectSupervisorRuntime: typeof connectSupervisorRuntime;
}

const chromeFocusDeps: ChromeFocusDeps = {
  captureFrontmostProcess,
  hideChromeWindow,
  startChromeFocusGuard,
  finalizeChromeFocusProtection,
};

const supervisorRuntimeDeps: SupervisorRuntimeDeps = {
  resolveSupervisorRuntimeContext,
  connectSupervisorRuntime,
};

function configuredSupervisorProjectUrl(
  meta: Awaited<ReturnType<typeof sessionStore.readSession>>,
): string | undefined {
  return (
    meta?.browser?.config?.supervisorChatgptUrl ??
    meta?.browser?.config?.chatgptUrl ??
    meta?.browser?.config?.url ??
    undefined
  );
}

function filterSupervisorThreadsForBrokerProjectScope(
  threads: SupervisorThreadInfo[],
  projectUrl?: string,
): SupervisorThreadInfo[] {
  const normalizedProjectUrl = projectUrl?.trim();
  if (!normalizedProjectUrl) {
    return threads;
  }
  return threads.filter(
    (thread) =>
      Boolean(thread.url?.trim()) &&
      supervisorThreadMatchesProjectScope(thread, normalizedProjectUrl),
  );
}

async function withChromeFocusProtection<T>(
  chromePid: number | undefined,
  action: () => Promise<T>,
  deps: ChromeFocusDeps = chromeFocusDeps,
): Promise<T> {
  if (process.platform !== "darwin" || !chromePid) {
    return action();
  }
  const chrome = { pid: chromePid } as LaunchedChrome;
  const frontmostProcess = await deps.captureFrontmostProcess(supervisorChromeLogger);
  const stopFocusGuard = deps.startChromeFocusGuard(
    chrome,
    supervisorChromeLogger,
    frontmostProcess,
    250,
  );
  try {
    await deps
      .hideChromeWindow(chrome, supervisorChromeLogger, frontmostProcess)
      .catch(() => undefined);
    return await action();
  } finally {
    await deps.finalizeChromeFocusProtection(
      chrome,
      supervisorChromeLogger,
      stopFocusGuard,
      frontmostProcess,
    );
  }
}

async function withSupervisorRuntime<T>(
  request: SupervisorBrokerRequest,
  action: (args: {
    Runtime: Awaited<ReturnType<typeof connectSupervisorRuntime>>["client"]["Runtime"];
    sessionId: string;
    targetId?: string;
  }) => Promise<T>,
  runtimeDeps: SupervisorRuntimeDeps = supervisorRuntimeDeps,
  focusDeps: ChromeFocusDeps = chromeFocusDeps,
): Promise<T> {
  const context = await runtimeDeps.resolveSupervisorRuntimeContext(request.followupSession);
  return await withChromeFocusProtection(
    context.runtime.chromePid,
    async () => {
      const connection = await runtimeDeps.connectSupervisorRuntime(context.runtime);
      try {
        return await action({
          Runtime: connection.client.Runtime,
          sessionId: context.sessionId,
          targetId: connection.targetId,
        });
      } finally {
        await connection.close();
      }
    },
    focusDeps,
  );
}

async function syncSupervisorRuntimeSession(
  sessionId: string,
  thread: SupervisorThreadInfo,
  targetId?: string,
): Promise<void> {
  const meta = await sessionStore.readSession(sessionId);
  const runtime = meta?.browser?.runtime;
  if (!runtime) {
    throw new Error(`Supervisor runtime session ${sessionId} is missing browser metadata.`);
  }
  if (!supervisorThreadMatchesProjectScope(thread, configuredSupervisorProjectUrl(meta))) {
    throw new Error(
      `Refusing to persist Oracle supervisor thread ${thread.conversationId} outside the configured project scope.`,
    );
  }
  await sessionStore.updateSession(sessionId, {
    browser: {
      config: meta.browser?.config,
      runtime: {
        ...runtime,
        chromeTargetId: targetId ?? runtime.chromeTargetId,
        tabUrl: thread.url ?? runtime.tabUrl,
        conversationId: thread.conversationId,
      },
    },
  });
}

function supervisorThreadSessionSlug(thread: SupervisorThreadInfo): string {
  const source = thread.conversationId?.trim() || thread.title.trim() || "chatgpt";
  const normalized = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `oracle-thread-${normalized || "chatgpt"}`;
}

async function createSupervisorThreadSession(
  sessionId: string,
  thread: SupervisorThreadInfo,
  targetId?: string,
): Promise<string> {
  const meta = await sessionStore.readSession(sessionId);
  const runtime = meta?.browser?.runtime;
  if (!meta || !runtime) {
    throw new Error(`Supervisor runtime session ${sessionId} is missing browser metadata.`);
  }
  if (!supervisorThreadMatchesProjectScope(thread, configuredSupervisorProjectUrl(meta))) {
    throw new Error(
      "Refusing to create an Oracle supervisor thread session outside the configured project scope.",
    );
  }

  const browser = {
    config: meta.browser?.config,
    runtime: {
      ...runtime,
      chromeTargetId: targetId ?? runtime.chromeTargetId,
      tabUrl: thread.url ?? runtime.tabUrl,
      conversationId: thread.conversationId,
    },
  };

  const model = meta.options.model ?? meta.options.effectiveModelId ?? meta.model ?? "gpt-5.4-pro";
  const created = await sessionStore.createSession(
    {
      prompt: `Supervisor thread: ${thread.title}`,
      model,
      models: meta.options.models,
      mode: "browser",
      browserConfig: browser.config,
      followupSessionId: sessionId,
      effectiveModelId: meta.options.effectiveModelId ?? model,
      search: meta.options.search,
      silent: true,
      waitPreference: true,
    },
    meta.cwd ?? process.cwd(),
    meta.notifications,
    supervisorThreadSessionSlug(thread),
  );

  await sessionStore.updateSession(created.id, {
    status: "completed",
    browser,
    promptPreview: `Supervisor thread: ${thread.title}`,
    mode: "browser",
    completedAt: new Date().toISOString(),
  });
  return created.id;
}

async function createAndSyncSupervisorThreadSession(
  sessionId: string,
  thread: SupervisorThreadInfo,
  targetId?: string,
): Promise<string> {
  await syncSupervisorRuntimeSession(sessionId, thread, targetId);
  return await createSupervisorThreadSession(sessionId, thread, targetId);
}

function normalizeOperation(request: SupervisorBrokerRequest): SupervisorBrokerOperation {
  return request.operation ?? request.action ?? "run_prompt";
}

function unsupportedOperationResponse(operation: string): SupervisorBrokerResponse {
  return {
    ok: false,
    error: `Unsupported supervisor operation: ${operation}`,
  };
}

export async function runSupervisorBrokerRequest(
  request: SupervisorBrokerRequest,
  deps: SupervisorBrokerDeps = {},
): Promise<SupervisorBrokerResponse> {
  try {
    const operation = normalizeOperation(request);
    switch (operation) {
      case "run_prompt":
        return (deps.runPrompt ?? runSupervisorPromptOperation)(request);
      case "list_threads":
        return (
          deps.listThreads ??
          (async (incoming: SupervisorBrokerRequest) =>
            withSupervisorRuntime(incoming, async ({ Runtime, sessionId }) => {
              const meta = await sessionStore.readSession(sessionId);
              return {
                ok: true as const,
                threads: filterSupervisorThreadsForBrokerProjectScope(
                  await listSupervisorThreads(Runtime, {
                    projectUrl: configuredSupervisorProjectUrl(meta),
                  }),
                  configuredSupervisorProjectUrl(meta),
                ),
              };
            }))
        )(request);
      case "new_thread":
        return (
          deps.newThread ??
          (async (incoming: SupervisorBrokerRequest) =>
            withSupervisorRuntime(incoming, async ({ Runtime, sessionId, targetId }) => {
              const meta = await sessionStore.readSession(sessionId);
              const thread = await newSupervisorThread(Runtime, {
                projectUrl: configuredSupervisorProjectUrl(meta),
              });
              const threadSessionId = await createAndSyncSupervisorThreadSession(
                sessionId,
                thread,
                targetId,
              );
              return {
                ok: true as const,
                thread,
                sessionId: threadSessionId,
              };
            }))
        )(request);
      case "attach_thread": {
        const conversationId = request.conversationId?.trim();
        if (!conversationId) {
          return {
            ok: false,
            error: "conversationId is required for attach_thread.",
          };
        }
        return (
          deps.attachThread ??
          (async (incoming: SupervisorBrokerRequest) =>
            withSupervisorRuntime(incoming, async ({ Runtime, sessionId, targetId }) => {
              const meta = await sessionStore.readSession(sessionId);
              const thread = await attachSupervisorThread(Runtime, conversationId, {
                projectUrl: configuredSupervisorProjectUrl(meta),
              });
              const threadSessionId = await createAndSyncSupervisorThreadSession(
                sessionId,
                thread,
                targetId,
              );
              return {
                ok: true as const,
                thread,
                sessionId: threadSessionId,
              };
            }))
        )(request);
      }
      default:
        return unsupportedOperationResponse(operation);
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function startSupervisorBroker(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let request: SupervisorBrokerRequest;
    try {
      request = JSON.parse(trimmed) as SupervisorBrokerRequest;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
      continue;
    }
    if (request.shutdown) {
      break;
    }
    const response = await runSupervisorBrokerRequest(request);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

export const __test__ = {
  withChromeFocusProtection,
  withSupervisorRuntime,
  syncSupervisorRuntimeSession,
  createSupervisorThreadSession,
  createAndSyncSupervisorThreadSession,
  filterSupervisorThreadsForBrokerProjectScope,
  supervisorThreadSessionSlug,
};
