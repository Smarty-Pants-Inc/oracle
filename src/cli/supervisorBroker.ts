import process from "node:process";
import readline from "node:readline";
import type { LaunchedChrome } from "chrome-launcher";
import {
  attachSupervisorThread,
  listSupervisorThreads,
  newSupervisorThread,
  type SupervisorThreadInfo,
} from "../browser/supervisorThreads.js";
import {
  captureFrontmostProcess,
  hideChromeWindow,
  startChromeFocusGuard,
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
const SUPERVISOR_FOCUS_GUARD_MS = 15_000;

interface ChromeFocusDeps {
  captureFrontmostProcess: typeof captureFrontmostProcess;
  hideChromeWindow: typeof hideChromeWindow;
  startChromeFocusGuard: typeof startChromeFocusGuard;
}

interface SupervisorRuntimeDeps {
  resolveSupervisorRuntimeContext: typeof resolveSupervisorRuntimeContext;
  connectSupervisorRuntime: typeof connectSupervisorRuntime;
}

const chromeFocusDeps: ChromeFocusDeps = {
  captureFrontmostProcess,
  hideChromeWindow,
  startChromeFocusGuard,
};

const supervisorRuntimeDeps: SupervisorRuntimeDeps = {
  resolveSupervisorRuntimeContext,
  connectSupervisorRuntime,
};

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
    SUPERVISOR_FOCUS_GUARD_MS,
  );
  try {
    await deps
      .hideChromeWindow(chrome, supervisorChromeLogger, frontmostProcess)
      .catch(() => undefined);
    return await action();
  } finally {
    stopFocusGuard();
    await deps.hideChromeWindow(chrome, supervisorChromeLogger).catch(() => undefined);
  }
}

async function withSupervisorRuntime<T>(
  request: SupervisorBrokerRequest,
  action: (args: {
    Runtime: Awaited<ReturnType<typeof connectSupervisorRuntime>>["client"]["Runtime"];
    sessionId: string;
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
): Promise<void> {
  const meta = await sessionStore.readSession(sessionId);
  const runtime = meta?.browser?.runtime;
  if (!runtime) {
    throw new Error(`Supervisor runtime session ${sessionId} is missing browser metadata.`);
  }
  await sessionStore.updateSession(sessionId, {
    browser: {
      config: meta.browser?.config,
      runtime: {
        ...runtime,
        tabUrl: thread.url ?? runtime.tabUrl,
        conversationId: thread.conversationId,
      },
    },
  });
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
          (async (incoming: SupervisorBrokerRequest) => ({
            ok: true as const,
            threads: await withSupervisorRuntime(incoming, ({ Runtime }) =>
              listSupervisorThreads(Runtime),
            ),
          }))
        )(request);
      case "new_thread":
        return (
          deps.newThread ??
          (async (incoming: SupervisorBrokerRequest) =>
            withSupervisorRuntime(incoming, async ({ Runtime, sessionId }) => {
              const thread = await newSupervisorThread(Runtime);
              await syncSupervisorRuntimeSession(sessionId, thread);
              return {
                ok: true as const,
                thread,
                sessionId,
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
            withSupervisorRuntime(incoming, async ({ Runtime, sessionId }) => {
              const thread = await attachSupervisorThread(Runtime, conversationId);
              await syncSupervisorRuntimeSession(sessionId, thread);
              return {
                ok: true as const,
                thread,
                sessionId,
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
};
