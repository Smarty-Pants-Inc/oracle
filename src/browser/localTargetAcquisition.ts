import {
  closeChromeTargetWithExactAuthority,
  connectWithNewTabWithExactAuthority,
} from "./chromeLifecycle.js";
import { connectToExistingChatGptTab } from "./liveTabs.js";
import { describeDevtoolsFirewallHint } from "./localExecutionContext.js";
import type { LocalBrowserAcquisition } from "./localAcquisition.js";
import type { LocalBrowserRunState } from "./localRunState.js";
import type { BrowserLogger } from "./types.js";
import { retainChromeTargetCloseCapability } from "./targetCloseAuthority.js";

export interface LocalTargetAcquisitionContext {
  acquisition: LocalBrowserAcquisition;
  state: LocalBrowserRunState;
  logger: BrowserLogger;
  publishRuntime: () => Promise<void>;
}

export async function acquireExactLocalBrowserTarget({
  acquisition,
  state,
  logger,
  publishRuntime,
}: LocalTargetAcquisitionContext): Promise<void> {
  const { chrome, chromeHost, config, manualLogin, resourceAuthority } = acquisition;
  const endpointAuthority = resourceAuthority.endpointAuthority();
  try {
    if (!endpointAuthority) {
      throw new Error("Locally owned Chrome has no retained exact endpoint authority.");
    }
    if (config.browserTabRef) {
      const attached = await connectToExistingChatGptTab({
        host: chromeHost,
        port: chrome.port,
        ref: config.browserTabRef,
        endpointAuthority,
      });
      state.client = attached.client;
      state.isolatedTargetId = attached.targetId ?? null;
      state.lastTargetId = attached.targetId ?? undefined;
      state.lastUrl = attached.tab.url || state.lastUrl;
      state.ownsTarget = false;
      logger(
        `Attached to existing ChatGPT tab ${attached.targetId}${attached.tab.url ? ` (${attached.tab.url})` : ""}`,
      );
    } else {
      const devtoolsRetries = manualLogin ? 6 : 0;
      await resourceAuthority.journalAcquisition({
        resource: "chrome-target",
        acquire: async () => {
          const opened = await connectWithNewTabWithExactAuthority(
            endpointAuthority,
            logger,
            resourceAuthority.targetMarkerUrl(),
            {
              retries: devtoolsRetries,
              retryDelayMs: 500,
            },
          );
          if (!opened.targetId) {
            await opened.client.close().catch(() => undefined);
            throw new Error("Locally owned Chrome did not return an exact dedicated target id.");
          }
          return opened;
        },
        authority: (opened) => {
          const targetId = opened.targetId as string;
          const targetCloseCapability = retainChromeTargetCloseCapability({
            generationId: resourceAuthority.generationId(),
            targetId,
            browserWSEndpoint: endpointAuthority.browserWSEndpoint,
            close: (closeLogger) =>
              closeChromeTargetWithExactAuthority({
                authority: endpointAuthority,
                targetId,
                logger: closeLogger,
              }),
          });
          state.client = opened.client;
          state.isolatedTargetId = targetId;
          state.lastTargetId = targetId;
          state.ownsTarget = true;
          state.targetCloseCapability = targetCloseCapability;
          return {
            targetId,
            capability: targetCloseCapability,
            disconnect: () => opened.client.close(),
          };
        },
      });
    }
    await publishRuntime();
    if (state.tabLease && state.isolatedTargetId) {
      await state.tabLease.update({
        chromeHost,
        chromePort: chrome.port,
        chromeTargetId: state.isolatedTargetId,
      });
    }
  } catch (error) {
    const hint = describeDevtoolsFirewallHint(chromeHost, chrome.port);
    if (hint) {
      logger(hint);
    }
    throw error;
  }
}
