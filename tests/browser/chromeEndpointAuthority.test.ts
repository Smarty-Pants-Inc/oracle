import { describe, expect, test, vi } from "vitest";
import {
  retainChromeBrowserWebSocketAuthority,
  type VerifiedDevToolsEndpoint,
} from "../../src/browser/chromeEndpointAuthority.js";
import type { ChromeClient } from "../../src/browser/types.js";

describe("restart-bound Chrome browser endpoint authority", () => {
  test("re-authenticates the exact endpoint generation before every operation", async () => {
    const browserWSEndpoint = "ws://service.example:9222/devtools/browser/exact-generation";
    const targets = { targetInfos: [{ targetId: "owned-target", type: "page" }] };
    const close = vi.fn(async () => undefined);
    const client = {
      Browser: { getVersion: vi.fn(async () => ({})) },
      Target: { getTargets: vi.fn(async () => targets) },
      close,
    } as unknown as ChromeClient;
    const discoverEndpoint = vi.fn(
      async (): Promise<VerifiedDevToolsEndpoint> => ({ port: 9222, browserWSEndpoint }),
    );
    const connectBrowser = vi.fn(async () => client);

    const retained = await retainChromeBrowserWebSocketAuthority(
      { host: "service.example", port: 9222, browserWSEndpoint },
      { discoverEndpoint, connectBrowser },
    );
    expect(retained.status).toBe("bound");
    if (retained.status !== "bound") throw new Error("expected bound endpoint authority");

    await expect(
      retained.authority.runExactOperation((exactClient) => exactClient.Target.getTargets()),
    ).resolves.toEqual({ status: "completed", value: targets });
    expect(discoverEndpoint).toHaveBeenCalledTimes(3);
    expect(connectBrowser).toHaveBeenCalledWith(browserWSEndpoint);
    await retained.authority.release();
    expect(close).toHaveBeenCalledOnce();
  });

  test("treats a replacement endpoint generation as gone without connecting to it", async () => {
    const connectBrowser = vi.fn();
    await expect(
      retainChromeBrowserWebSocketAuthority(
        {
          host: "service.example",
          port: 9222,
          browserWSEndpoint: "ws://service.example:9222/devtools/browser/original-generation",
        },
        {
          discoverEndpoint: vi.fn(async () => ({
            port: 9222,
            browserWSEndpoint: "ws://service.example:9222/devtools/browser/replacement-generation",
          })),
          connectBrowser,
        },
      ),
    ).resolves.toEqual({ status: "gone" });
    expect(connectBrowser).not.toHaveBeenCalled();
  });

  test("keeps ambiguous endpoint discovery failures pending", async () => {
    await expect(
      retainChromeBrowserWebSocketAuthority(
        {
          host: "service.example",
          port: 9222,
          browserWSEndpoint: "ws://service.example:9222/devtools/browser/exact-generation",
        },
        {
          discoverEndpoint: vi.fn(async () => {
            throw new Error("service unreachable");
          }),
        },
      ),
    ).resolves.toMatchObject({
      status: "unsafe",
      reason: expect.stringContaining("service unreachable"),
    });
  });
});
