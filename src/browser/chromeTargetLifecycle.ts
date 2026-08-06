import CDP from "chrome-remote-interface";
import type { BrowserLogger, ChromeClient } from "./types.js";
import type {
  ExactChromeEndpointOperationResult,
  RetainedChromeEndpointAuthority,
} from "./chromeEndpointAuthority.js";
import {
  adaptDirectTargetChromeClient,
  createBrowserLevelChromeClient,
  createSessionBoundChromeClient,
  type ChromeTargetAttachment,
} from "./chromeSessionTransport.js";
import { delay } from "./utils.js";

export interface RemoteTargetInfo {
  targetId?: string;
  type?: string;
  title?: string;
  url?: string;
}

export interface ChromeTargetOperations {
  list(): Promise<RemoteTargetInfo[]>;
  create(url: string): Promise<string>;
  attach(targetId: string): Promise<ChromeTargetAttachment>;
  close(targetId: string): Promise<boolean>;
}

export interface TargetConnectMessages {
  opened?: (targetId: string) => string;
  openFailed: (message: string) => string;
  attachFailed: (targetId: string, message: string) => string;
  closeFailed: (targetId: string, message: string) => string;
}

export type ExactChromeTargetOperationAuthority = Pick<
  RetainedChromeEndpointAuthority,
  "runExactOperation"
>;

export type ExactChromeTargetCleanupResult =
  | { status: "completed" }
  | { status: "gone" }
  | { status: "unsafe"; reason: string };

export class ExactTargetOperationFailure extends Error {
  constructor(
    readonly result: Exclude<ExactChromeEndpointOperationResult<never>, { status: "completed" }>,
  ) {
    super(result.status === "gone" ? "Exact Chrome process generation exited" : result.reason);
    this.name = "ExactTargetOperationFailure";
  }
}

export class TargetOpenFailure extends Error {
  constructor(
    readonly stage: "create" | "attach",
    readonly targetId: string | undefined,
    readonly cause: unknown,
    readonly cleanupError?: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TargetOpenFailure";
  }
}

export function findExactTargetOperationFailure(
  error: unknown,
): ExactTargetOperationFailure | undefined {
  if (error instanceof ExactTargetOperationFailure) return error;
  if (!(error instanceof TargetOpenFailure)) return undefined;
  if (error.cause instanceof ExactTargetOperationFailure) return error.cause;
  return error.cleanupError instanceof ExactTargetOperationFailure ? error.cleanupError : undefined;
}

export function mapRemoteTarget(target: {
  id?: string;
  targetId?: string;
  type?: string;
  title?: string;
  url?: string;
}): RemoteTargetInfo {
  return {
    targetId: target.targetId ?? target.id,
    type: target.type,
    title: target.title,
    url: target.url,
  };
}

export function rawChromeTargetOperations(host: string, port: number): ChromeTargetOperations {
  return {
    list: async () =>
      (
        (await CDP.List({ host, port })) as Array<{
          id?: string;
          targetId?: string;
          type?: string;
          title?: string;
          url?: string;
        }>
      ).map(mapRemoteTarget),
    create: async (url) => {
      const created = (await CDP.New({ host, port, url })) as { id?: string; targetId?: string };
      const targetId = created.targetId ?? created.id;
      if (!targetId) throw new Error("Chrome target creation returned no target id");
      return targetId;
    },
    attach: async (targetId) =>
      adaptDirectTargetChromeClient(await CDP({ host, port, target: targetId })),
    close: async (targetId) => {
      await CDP.Close({ host, port, id: targetId });
      return true;
    },
  };
}

export function browserChromeTargetOperations(browser: ChromeClient): ChromeTargetOperations {
  const browserClient = createBrowserLevelChromeClient({
    run: async (operation) => await operation(browser),
  });
  return {
    list: async () => ((await browser.Target.getTargets()).targetInfos ?? []).map(mapRemoteTarget),
    create: async (url) => {
      const created = await browser.Target.createTarget({ url });
      if (!created.targetId) throw new Error("Chrome target creation returned no target id");
      return created.targetId;
    },
    attach: async (targetId) => {
      const attached = await browser.Target.attachToTarget({ targetId, flatten: true });
      return createSessionBoundChromeClient(browser, attached.sessionId, browserClient);
    },
    close: async (targetId) => (await browser.Target.closeTarget({ targetId })).success !== false,
  };
}

export async function openChromeTarget(
  operations: ChromeTargetOperations,
  url: string,
): Promise<ChromeTargetAttachment & { targetId: string }> {
  let targetId: string;
  try {
    targetId = await operations.create(url);
  } catch (error) {
    throw new TargetOpenFailure("create", undefined, error);
  }
  try {
    return { ...(await operations.attach(targetId)), targetId };
  } catch (error) {
    try {
      if (!(await operations.close(targetId))) {
        throw new Error(`Chrome rejected cleanup of unused target ${targetId}`);
      }
    } catch (cleanupError) {
      throw new TargetOpenFailure("attach", targetId, error, cleanupError);
    }
    throw new TargetOpenFailure("attach", targetId, error);
  }
}

function describeTargetOpenFailure(error: unknown, messages: TargetConnectMessages): string[] {
  if (!(error instanceof TargetOpenFailure)) {
    return [messages.openFailed(error instanceof Error ? error.message : String(error))];
  }
  const message = error.cause instanceof Error ? error.cause.message : String(error.cause);
  const lines =
    error.stage === "create" || !error.targetId
      ? [messages.openFailed(message)]
      : [messages.attachFailed(error.targetId, message)];
  if (error.cleanupError && error.targetId) {
    lines.push(
      messages.closeFailed(
        error.targetId,
        error.cleanupError instanceof Error
          ? error.cleanupError.message
          : String(error.cleanupError),
      ),
    );
  }
  return lines;
}

export async function connectToNewTarget(
  operations: ChromeTargetOperations,
  url: string,
  logger: BrowserLogger,
  messages: TargetConnectMessages,
  options?: { retries?: number; retryDelayMs?: number },
): Promise<ChromeTargetAttachment & { targetId: string }> {
  const retries = Math.max(0, options?.retries ?? 0);
  const retryDelayMs = Math.max(0, options?.retryDelayMs ?? 250);
  let attempt = 0;
  while (true) {
    try {
      const connection = await openChromeTarget(operations, url);
      if (messages.opened) logger(messages.opened(connection.targetId));
      return connection;
    } catch (error) {
      for (const message of describeTargetOpenFailure(error, messages)) logger(message);
      const exactFailure = findExactTargetOperationFailure(error);
      if (exactFailure || attempt >= retries) throw exactFailure ?? error;
      attempt += 1;
      await delay(retryDelayMs * attempt);
    }
  }
}

const CLOSE_CONFIRM_ATTEMPTS = 40;
const CLOSE_CONFIRM_DELAY_MS = 25;

export async function confirmChromeTargetClosed(
  operations: ChromeTargetOperations,
  targetId: string,
  logger: BrowserLogger,
): Promise<boolean> {
  for (let attempt = 0; attempt < CLOSE_CONFIRM_ATTEMPTS; attempt += 1) {
    await delay(CLOSE_CONFIRM_DELAY_MS);
    try {
      if (!(await operations.list()).some((target) => target.targetId === targetId)) {
        logger(`Closed isolated browser tab (target=${targetId})`);
        return true;
      }
    } catch (error) {
      if (error instanceof ExactTargetOperationFailure) throw error;
    }
  }
  logger(`Browser tab close was not confirmed (target=${targetId})`);
  return false;
}

export async function ensureChromePageTarget(
  operations: ChromeTargetOperations,
  closingTargetId: string,
  logger: BrowserLogger,
  knownTargets?: RemoteTargetInfo[],
): Promise<string | undefined> {
  let targets = knownTargets;
  if (!targets) {
    try {
      targets = await operations.list();
    } catch (error) {
      if (error instanceof ExactTargetOperationFailure) throw error;
      logger(
        `Failed to inspect Chrome tabs before closing ${closingTargetId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      targets = [];
    }
  }
  const existingPageTargetId = targets
    .filter((target) => target.type === "page")
    .map((target) => target.targetId)
    .find((targetId): targetId is string => Boolean(targetId) && targetId !== closingTargetId);
  if (existingPageTargetId) return existingPageTargetId;
  const replacementTargetId = await operations.create("about:blank");
  logger(`Opened replacement Chrome tab (target=${replacementTargetId})`);
  return replacementTargetId;
}

export async function closeChromeTargetWithOperations(
  operations: ChromeTargetOperations,
  targetId: string,
  logger: BrowserLogger,
): Promise<boolean> {
  let targets: RemoteTargetInfo[];
  let listed = true;
  try {
    targets = await operations.list();
  } catch (error) {
    if (error instanceof ExactTargetOperationFailure) throw error;
    logger(
      `Failed to inspect Chrome tabs before closing ${targetId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    listed = false;
    targets = [];
  }
  if (listed && targets.some((target) => target.targetId === targetId) === false) {
    logger(`Closed isolated browser tab (target=${targetId})`);
    return true;
  }
  try {
    const replacement = await ensureChromePageTarget(operations, targetId, logger, targets);
    if (!replacement) {
      logger(
        `[browser] Leaving browser tab ${targetId} open because Chrome has no replacement page target.`,
      );
      return false;
    }
    if (!(await operations.close(targetId))) {
      logger(`Browser tab close was rejected (target=${targetId})`);
      return false;
    }
  } catch (error) {
    try {
      if (!(await operations.list()).some((target) => target.targetId === targetId)) {
        logger(`Closed isolated browser tab (target=${targetId})`);
        return true;
      }
    } catch (confirmationError) {
      if (confirmationError instanceof ExactTargetOperationFailure) throw confirmationError;
    }
    throw error;
  }
  return await confirmChromeTargetClosed(operations, targetId, logger);
}

export type BlankChromeTargetCleanup = {
  closed: number;
  failures: Array<{ targetId: string; reason: string }>;
};

export async function closeBlankChromeTargets(
  operations: ChromeTargetOperations,
  options?: {
    excludeTargetIds?: Iterable<string | null | undefined>;
    preserveOneBlank?: boolean;
  },
): Promise<BlankChromeTargetCleanup> {
  const excluded = new Set(
    [...(options?.excludeTargetIds ?? [])].filter(
      (targetId): targetId is string => typeof targetId === "string" && targetId.length > 0,
    ),
  );
  const targets = await operations.list();
  const preservedBlankTargetId = options?.preserveOneBlank
    ? targets
        .filter(isBlankPageTarget)
        .map((target) => target.targetId)
        .filter((targetId): targetId is string => Boolean(targetId))
        .sort()[0]
    : undefined;
  const failures: BlankChromeTargetCleanup["failures"] = [];
  let closed = 0;
  for (const target of targets) {
    const targetId = target.targetId;
    if (
      !targetId ||
      targetId === preservedBlankTargetId ||
      excluded.has(targetId) ||
      !isBlankPageTarget(target)
    ) {
      continue;
    }
    try {
      if (!(await operations.close(targetId))) {
        throw new Error(`Chrome rejected blank target close for ${targetId}`);
      }
      closed += 1;
    } catch (error) {
      if (error instanceof ExactTargetOperationFailure) throw error;
      failures.push({ targetId, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { closed, failures };
}

async function runExactEndpointOperation<T>(
  authority: ExactChromeTargetOperationAuthority,
  operation: (client: ChromeClient) => Promise<T>,
): Promise<ExactChromeEndpointOperationResult<T>> {
  if (!authority.runExactOperation) {
    return {
      status: "unsafe",
      reason: "Retained Chrome endpoint authority cannot authenticate deferred target effects",
    };
  }
  return await authority.runExactOperation(operation);
}

export function exactChromeTargetOperations(
  authority: ExactChromeTargetOperationAuthority,
): ChromeTargetOperations {
  const run = async <T>(operation: (client: ChromeClient) => Promise<T>): Promise<T> => {
    const result = await runExactEndpointOperation(authority, operation);
    if (result.status === "completed") return result.value;
    throw new ExactTargetOperationFailure(result);
  };
  const browserClient = createBrowserLevelChromeClient({ run });
  return {
    list: async () =>
      await run(async (client) =>
        ((await client.Target.getTargets()).targetInfos ?? []).map(mapRemoteTarget),
      ),
    create: async (url) =>
      await run(async (client) => {
        const created = await client.Target.createTarget({ url });
        if (!created.targetId)
          throw new Error("Exact Chrome target creation returned no target id");
        return created.targetId;
      }),
    attach: async (targetId) =>
      await run(async (client) => {
        const attached = await client.Target.attachToTarget({ targetId, flatten: true });
        return createSessionBoundChromeClient(client, attached.sessionId, browserClient);
      }),
    close: async (targetId) =>
      await run(
        async (client) => (await client.Target.closeTarget({ targetId })).success !== false,
      ),
  };
}

export async function exactTargetResult<T>(
  operation: () => Promise<T>,
): Promise<ExactChromeEndpointOperationResult<T>> {
  try {
    return { status: "completed", value: await operation() };
  } catch (error) {
    const exactFailure = findExactTargetOperationFailure(error);
    if (exactFailure) return exactFailure.result;
    return {
      status: "unsafe",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export class ExactChromeEndpointAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExactChromeEndpointAuthorityError";
  }
}

export function requireExactChromeEndpointOperation<T>(
  result: ExactChromeEndpointOperationResult<T>,
  operation: string,
): T {
  if (result.status === "completed") return result.value;
  if (result.status === "gone") {
    throw new ExactChromeEndpointAuthorityError(
      `${operation}: exact Chrome process generation exited`,
    );
  }
  throw new ExactChromeEndpointAuthorityError(`${operation}: ${result.reason}`);
}

function isBlankPageTarget(target: { type?: string; url?: string }): boolean {
  if (target.type && target.type !== "page") return false;
  const url = (target.url ?? "").trim().toLowerCase();
  return url === "about:blank" || url === "chrome://newtab/" || url === "chrome://new-tab-page/";
}
