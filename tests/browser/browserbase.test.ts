import { describe, expect, test, vi } from "vitest";
import {
  BrowserbaseClient,
  type BrowserbaseCreateSessionOptions,
} from "../../src/browser/browserbase.js";

describe("BrowserbaseClient", () => {
  test("creates contexts with the configured project", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ id: "ctx_123" }));
    const client = new BrowserbaseClient({ apiKey: "bb_test", projectId: "proj_123", fetcher });

    await expect(client.createContext()).resolves.toEqual({ id: "ctx_123" });

    expect(fetcher).toHaveBeenCalledWith("https://api.browserbase.com/v1/contexts", {
      method: "POST",
      headers: browserbaseHeaders("bb_test"),
      body: JSON.stringify({ projectId: "proj_123" }),
    });
  });

  test("creates contexts without a project id when Browserbase infers it from the API key", async () => {
    await withoutBrowserbaseProjectId(async () => {
      const fetcher = vi.fn(async () => jsonResponse({ id: "ctx_123" }));
      const client = new BrowserbaseClient({ apiKey: "bb_test", fetcher });

      await expect(client.createContext()).resolves.toEqual({ id: "ctx_123" });
      expect(fetcher).toHaveBeenCalledWith("https://api.browserbase.com/v1/contexts", {
        method: "POST",
        headers: browserbaseHeaders("bb_test"),
        body: JSON.stringify({}),
      });
    });
  });

  test("creates sessions with a persistent context by default", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        id: "sess_123",
        projectId: "proj_123",
        status: "RUNNING",
        contextId: "ctx_123",
      }),
    );
    const client = new BrowserbaseClient({
      apiKey: "bb_test",
      projectId: "proj_123",
      apiUrl: "https://example.test/v1/",
      fetcher,
    });

    await client.createSession({
      extensionId: "ext_123",
      contextId: "ctx_123",
      keepAlive: true,
      timeout: 60,
      region: "us-west-2",
      proxies: [
        {
          type: "browserbase",
          geolocation: { country: "US" },
        },
      ],
      browserSettings: {
        advancedStealth: true,
        solveCaptchas: false,
      },
      userMetadata: { owner: "oracle" },
    });

    const body = parsedBody(fetcher, 0);
    expect(fetchCall(fetcher, 0)[0]).toBe("https://example.test/v1/sessions");
    expect(body).toEqual({
      projectId: "proj_123",
      extensionId: "ext_123",
      keepAlive: true,
      timeout: 60,
      region: "us-west-2",
      proxies: [
        {
          type: "browserbase",
          geolocation: { country: "US" },
        },
      ],
      browserSettings: {
        advancedStealth: true,
        solveCaptchas: false,
        context: {
          id: "ctx_123",
          persist: true,
        },
      },
      userMetadata: { owner: "oracle" },
    });
  });

  test("allows callers to opt out of context persistence", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ id: "sess_123", projectId: "proj_123", status: "RUNNING" }),
    );
    const client = new BrowserbaseClient({ apiKey: "bb_test", projectId: "proj_123", fetcher });
    const options: BrowserbaseCreateSessionOptions = {
      contextId: "ctx_123",
      persistContext: false,
      proxy: true,
      browserSettings: { viewport: { width: 1280, height: 720 } },
    };

    await client.createSession(options);

    expect(parsedBody(fetcher, 0)).toEqual({
      projectId: "proj_123",
      proxies: true,
      browserSettings: {
        viewport: { width: 1280, height: 720 },
        context: {
          id: "ctx_123",
          persist: false,
        },
      },
    });
  });

  test("retrieves debug urls", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        debuggerFullscreenUrl: "https://debug.example/full",
        debuggerUrl: "https://debug.example",
        pages: [],
        wsUrl: "wss://debug.example",
      }),
    );
    const client = new BrowserbaseClient({ apiKey: "bb_test", fetcher });

    await expect(client.getDebugUrls("sess/123")).resolves.toMatchObject({
      debuggerUrl: "https://debug.example",
    });
    expect(fetchCall(fetcher, 0)[0]).toBe(
      "https://api.browserbase.com/v1/sessions/sess%2F123/debug",
    );
    expect(fetchCall(fetcher, 0)[1]).toMatchObject({ method: "GET" });
  });

  test("retrieves a session with a fresh connect url", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({
        id: "sess_123",
        projectId: "proj_123",
        status: "RUNNING",
        connectUrl: "wss://connect.browserbase.example/devtools/browser/sess_123",
      }),
    );
    const client = new BrowserbaseClient({ apiKey: "bb_test", fetcher });

    await expect(client.getSession("sess/123")).resolves.toMatchObject({
      connectUrl: "wss://connect.browserbase.example/devtools/browser/sess_123",
    });
    expect(fetchCall(fetcher, 0)[0]).toBe("https://api.browserbase.com/v1/sessions/sess%2F123");
    expect(fetchCall(fetcher, 0)[1]).toMatchObject({ method: "GET" });
  });

  test("requests session release through session update", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse({ id: "sess_123", projectId: "proj_123", status: "COMPLETED" }),
    );
    const client = new BrowserbaseClient({ apiKey: "bb_test", projectId: "proj_123", fetcher });

    await client.requestSessionRelease("sess_123");

    expect(fetchCall(fetcher, 0)[0]).toBe("https://api.browserbase.com/v1/sessions/sess_123");
    expect(parsedBody(fetcher, 0)).toEqual({
      projectId: "proj_123",
      status: "REQUEST_RELEASE",
    });
  });

  test("surfaces Browserbase API errors with response body", async () => {
    const fetcher = vi.fn(async () => new Response("bad request", { status: 400 }));
    const client = new BrowserbaseClient({ apiKey: "bb_test", fetcher });

    await expect(client.getDebugUrls("sess_123")).rejects.toMatchObject({
      name: "BrowserbaseError",
      message: "Browserbase API request failed: 400: bad request",
      status: 400,
      body: "bad request",
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function browserbaseHeaders(apiKey: string): Record<string, string> {
  return { "Content-Type": "application/json", "X-BB-API-Key": apiKey };
}

function fetchCall(fetcher: ReturnType<typeof vi.fn>, callIndex: number): [string, RequestInit] {
  const call = fetcher.mock.calls[callIndex] as unknown as [string, RequestInit] | undefined;
  expect(call).toBeDefined();
  return call as [string, RequestInit];
}

function parsedBody(fetcher: ReturnType<typeof vi.fn>, callIndex: number): unknown {
  const body = fetchCall(fetcher, callIndex)[1].body;
  expect(typeof body).toBe("string");
  return JSON.parse(body as string);
}

async function withoutBrowserbaseProjectId(run: () => Promise<void>): Promise<void> {
  const previous = process.env.BROWSERBASE_PROJECT_ID;
  delete process.env.BROWSERBASE_PROJECT_ID;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.BROWSERBASE_PROJECT_ID;
    else process.env.BROWSERBASE_PROJECT_ID = previous;
  }
}
