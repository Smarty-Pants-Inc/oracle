import type {
  BrowserAttachment,
  BrowserLogger,
  BrowserRunOptions,
  BrowserRunTransaction,
  ResolvedBrowserConfig,
} from "./types.js";
import { createRemoteBrowserExecutionContext } from "./remoteExecutionContext.js";
import { acquireRemoteBrowserTarget } from "./remoteTargetAcquisition.js";
import { runRemotePromptLoop } from "./remotePromptLoop.js";
import {
  finalizeRemoteBrowserRun,
  handleRemoteBrowserFailure,
  settleRemoteResources,
} from "./remoteDisconnectSettlement.js";

// Remote browser lane coordinator.
export async function runRemoteBrowserMode(
  promptText: string,
  attachments: BrowserAttachment[],
  config: ResolvedBrowserConfig,
  logger: BrowserLogger,
  options: BrowserRunOptions,
): Promise<BrowserRunTransaction> {
  const context = createRemoteBrowserExecutionContext(
    promptText,
    attachments,
    config,
    logger,
    options,
    settleRemoteResources,
  );
  try {
    const target = await acquireRemoteBrowserTarget(context);
    return await runRemotePromptLoop(context, target);
  } catch (error) {
    return await handleRemoteBrowserFailure(context, error);
  } finally {
    await finalizeRemoteBrowserRun(context);
  }
}
