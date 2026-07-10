import { describe, expect, test, vi } from "vitest";

import { runOracle } from "@src/oracle.ts";
import { MockClient, MockStream, buildResponse } from "./helpers.ts";

describe("runOracle request payload", () => {
  test("maps gpt-5.1-pro alias to gpt-5.6-sol API model", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "Alias check",
        model: "gpt-5.1-pro",
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: (msg: string) => logs.push(msg),
      },
    );
    expect(client.lastRequest?.model).toBe("gpt-5.6-sol");
    expect(client.lastRequest?.reasoning).toEqual({ effort: "xhigh", mode: "pro" });
    expect(logs.join("\n")).toContain("(API: gpt-5.6-sol)");
    expect(logs.join("\n")).toContain("gpt-5.1-pro");
    expect(logs.join("\n")).toContain("OpenAI API uses `gpt-5.6-sol`");
  });

  test("maps gpt-5.2-pro alias to gpt-5.6-sol API model", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const logs: string[] = [];
    await runOracle(
      {
        prompt: "Alias check",
        model: "gpt-5.2-pro",
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: (msg: string) => logs.push(msg),
      },
    );
    expect(client.lastRequest?.model).toBe("gpt-5.6-sol");
    expect(client.lastRequest?.reasoning).toEqual({ effort: "xhigh", mode: "pro" });
    expect(logs.join("\n")).toContain("(API: gpt-5.6-sol)");
    expect(logs.join("\n")).toContain("gpt-5.2-pro");
    expect(logs.join("\n")).toContain("OpenAI API uses `gpt-5.6-sol`");
  });

  test("keeps standard gpt-5.6-sol on xhigh effort without Pro mode", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    await runOracle(
      {
        prompt: "Standard reasoning check",
        model: "gpt-5.6-sol",
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: () => {},
      },
    );
    expect(client.lastRequest?.model).toBe("gpt-5.6-sol");
    expect(client.lastRequest?.reasoning).toEqual({ effort: "xhigh" });
  });

  test("uses GPT-5.6 long-context pricing above 272k input tokens", async () => {
    const stream = new MockStream(
      [],
      buildResponse({
        usage: {
          input_tokens: 300_000,
          output_tokens: 100_000,
          reasoning_tokens: 0,
          total_tokens: 400_000,
        },
      }),
    );
    const client = new MockClient(stream);
    const result = await runOracle(
      {
        prompt: "Long context pricing check",
        model: "gpt-5.6-sol-pro",
        background: false,
        silent: true,
      },
      {
        apiKey: "sk-test",
        client,
        log: () => {},
      },
    );
    expect(result.mode).toBe("live");
    if (result.mode === "live") {
      expect(result.usage.cost).toBeCloseTo(7.5);
    }
  });

  test("search enabled by default", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    await runOracle(
      {
        prompt: "Default search",
        model: "gpt-5.2-pro",
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: () => {},
      },
    );
    expect(client.lastRequest?.tools).toEqual([{ type: "web_search_preview" }]);
  });

  test("passes baseUrl through to clientFactory", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const captured: Array<{ apiKey: string; baseUrl?: string }> = [];
    await runOracle(
      {
        prompt: "Custom endpoint",
        model: "gpt-5.2-pro",
        baseUrl: "https://litellm.test/v1",
        background: false,
      },
      {
        apiKey: "sk-test",
        clientFactory: (apiKey, options) => {
          captured.push({ apiKey, baseUrl: options?.baseUrl });
          return client;
        },
        log: () => {},
        write: () => true,
      },
    );
    expect(captured).toEqual([{ apiKey: "sk-test", baseUrl: "https://litellm.test/v1" }]);
  });

  test("passes gemini custom baseUrl through to clientFactory", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const captured: Array<{ apiKey: string; baseUrl?: string; model?: string }> = [];
    await runOracle(
      {
        prompt: "Gemini custom endpoint",
        model: "gemini-3-pro",
        baseUrl: "https://litellm.test/v1",
        background: false,
      },
      {
        apiKey: "gk-test",
        clientFactory: (apiKey, options) => {
          captured.push({ apiKey, baseUrl: options?.baseUrl, model: options?.model });
          return client;
        },
        log: () => {},
        write: () => true,
      },
    );
    expect(captured).toEqual([
      { apiKey: "gk-test", baseUrl: "https://litellm.test/v1", model: "gemini-3-pro" },
    ]);
  });

  test("keeps explicit claude baseUrl even when ANTHROPIC_BASE_URL is set", async () => {
    const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://env.anthropic.test/v1";

    try {
      const stream = new MockStream([], buildResponse());
      const client = new MockClient(stream);
      const captured: Array<{ apiKey: string; baseUrl?: string; model?: string }> = [];
      await runOracle(
        {
          prompt: "Claude custom endpoint",
          model: "claude-4.6-sonnet",
          baseUrl: "https://litellm.test/v1",
          background: false,
        },
        {
          apiKey: "ak-test",
          clientFactory: (apiKey, options) => {
            captured.push({ apiKey, baseUrl: options?.baseUrl, model: options?.model });
            return client;
          },
          log: () => {},
          write: () => true,
        },
      );
      expect(captured).toEqual([
        { apiKey: "ak-test", baseUrl: "https://litellm.test/v1", model: "claude-4.6-sonnet" },
      ]);
    } finally {
      if (originalAnthropicBaseUrl === undefined) {
        delete process.env.ANTHROPIC_BASE_URL;
      } else {
        process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
      }
    }
  });

  test("passes azure config to clientFactory and sends the deployment name as the Azure model", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    const captured: Array<{ apiKey: string; azure?: unknown; resolvedModelId?: string }> = [];
    const azureOptions = {
      endpoint: "https://my-azure.com/",
      deployment: "gpt-4-test",
      apiVersion: "2024-01-01",
    };

    await runOracle(
      {
        prompt: "Azure test",
        model: "gpt-5.2-pro",
        azure: azureOptions,
        background: false,
      },
      {
        apiKey: "sk-test",
        clientFactory: (apiKey, options) => {
          captured.push({
            apiKey,
            azure: options?.azure,
            resolvedModelId: options?.resolvedModelId,
          });
          return client;
        },
        log: () => {},
        write: () => true,
      },
    );
    expect(captured).toEqual([
      { apiKey: "sk-test", azure: azureOptions, resolvedModelId: "gpt-4-test" },
    ]);
    expect(client.lastRequest?.model).toBe("gpt-4-test");
  });

  test("uses grok search tool shape", async () => {
    const stream = new MockStream([], buildResponse());
    const client = new MockClient(stream);
    await runOracle(
      {
        prompt: "Search capability",
        model: "grok-4.1",
        background: false,
      },
      {
        apiKey: "sk-test",
        client,
        log: () => {},
      },
    );
    expect(client.lastRequest?.tools).toEqual([{ type: "web_search" }]);
    expect(client.lastRequest?.background).toBeUndefined();
  });

  test("forces foreground for models without background support (grok)", async () => {
    const stream = new MockStream([], buildResponse());
    const createSpy = vi.fn();
    const client = new MockClient(stream);
    // Override background create handler to fail if invoked.
    client.responses.create = createSpy.mockImplementation(() => {
      throw new Error("create should not be called for grok");
    });
    await runOracle(
      {
        prompt: "Please run in foreground",
        model: "grok-4.1",
        background: true,
      },
      {
        apiKey: "sk-test",
        client,
        log: () => {},
      },
    );
    expect(createSpy).not.toHaveBeenCalled();
  });
});
