import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  collectChatGptFileArtifacts,
  readAssistantDownloadableFiles,
  saveAssistantDownloadButtonArtifacts,
  saveChatGptDownloadableFiles,
  __test__,
} from "../../src/browser/chatgptFiles.js";
import {
  acquireBrowserDownloadBehaviorLock,
  resolveBrowserDownloadBehaviorLockPath,
} from "../../src/browser/downloadBehaviorLock.js";
import type { ChromeClient } from "../../src/browser/types.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

function createDeferredPromise<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeElement {
  clickCount = 0;

  constructor(
    public textContent = "",
    public attributes: Record<string, string> = {},
    public className = "",
    public children: FakeElement[] = [],
    public tagName = "BUTTON",
  ) {}

  get href(): string {
    return this.attributes.href ?? "";
  }

  click(): void {
    this.clickCount += 1;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  querySelector(): FakeElement | null {
    return null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    if (!selector.includes("button") && !selector.includes("a[") && !selector.includes("[role=")) {
      return [];
    }
    return this.children.filter(
      (child) =>
        child.tagName === "BUTTON" ||
        child.tagName === "A" ||
        child.getAttribute("role") === "button",
    );
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

function assistantTurn(buttons: FakeElement[]): FakeElement {
  return new FakeElement("", { "data-turn": "assistant" }, "", buttons, "DIV");
}

function behaviorButton(text: string, attributes: Record<string, string> = {}): FakeElement {
  return new FakeElement(text, attributes, "behavior-btn", [], "BUTTON");
}

function anchorControl(text: string, attributes: Record<string, string> = {}): FakeElement {
  return new FakeElement(text, attributes, "", [], "A");
}

function evaluateClickExpression(expression: string, turns: FakeElement[]): unknown[] {
  const document = { querySelectorAll: () => turns };
  return Function(
    "document",
    "HTMLElement",
    `return ${expression};`,
  )(document, FakeElement) as unknown[];
}

describe("readAssistantDownloadableFiles", () => {
  test("keeps ChatGPT file downloads and sandbox references but rejects external links", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              url: "https://evil.example/archive.zip",
              filename: "archive.zip",
            },
            {
              url: "https://chatgpt.com/backend-api/me",
              downloadUrl: "https://chatgpt.com/backend-api/me",
              filename: "not-a-file.json",
            },
            {
              url: "https://chatgpt.com/backend-api/files/file_package/download",
              downloadUrl: "https://chatgpt.com/backend-api/files/file_package/download",
              sandboxUrl: "sandbox:/mnt/data/package.zip",
              filename: "package.zip",
              label: "package.zip",
            },
            {
              url: "sandbox:/mnt/data/source.tar.gz",
              sandboxUrl: "sandbox:/mnt/data/source.tar.gz",
              filename: "source.tar.gz",
            },
          ],
        },
      }),
    } as unknown as ChromeClient["Runtime"];

    const files = await readAssistantDownloadableFiles(runtime);

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({
      url: "https://chatgpt.com/backend-api/files/file_package/download",
      sandboxUrl: "sandbox:/mnt/data/package.zip",
      filename: "package.zip",
    });
    expect(files[1]).toMatchObject({
      url: "sandbox:/mnt/data/source.tar.gz",
      sandboxUrl: "sandbox:/mnt/data/source.tar.gz",
      filename: "source.tar.gz",
    });
  });

  test("embeds exact conversation and account checks in the DOM read", async () => {
    let expression = "";
    const runtime = {
      evaluate: vi.fn(async (options: { expression: string }) => {
        expression = options.expression;
        return { result: { value: [] } };
      }),
    } as unknown as ChromeClient["Runtime"];
    await readAssistantDownloadableFiles(
      runtime,
      undefined,
      undefined,
      "expected-thread",
      "a".repeat(64),
      "https://chatgpt.com/g/g-p-test/project/c/expected-thread",
    );
    expect(expression).toContain('const expectedConversationId = "expected-thread"');
    expect(expression).toContain(
      'const expectedConversationUrl = "https://chatgpt.com/g/g-p-test/project/c/expected-thread"',
    );
    expect(expression).toContain("pageUrl.pathname");
    expect(
      expression.match(/await assertOracleChatGptPageAffinity\(\);/g)?.length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("saveChatGptDownloadableFiles", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    setOracleHomeDirOverrideForTest(null);
  });

  test("saves ChatGPT downloadable files as session artifacts with cookies", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-files-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://chatgpt.com/backend-api/files/file_package/download?token=ok",
      headers: {
        get: (name: string) => {
          if (name === "content-type") return "application/zip";
          if (name === "content-disposition") return 'attachment; filename="package.zip"';
          return null;
        },
      },
      arrayBuffer: async () => Uint8Array.from([9, 8, 7]).buffer,
    } as unknown as Response);

    const result = await saveChatGptDownloadableFiles({
      Network: network,
      sessionId: "file-session",
      files: [
        {
          url: "https://chatgpt.com/backend-api/files/file_package/download",
          downloadUrl: "https://chatgpt.com/backend-api/files/file_package/download",
          sandboxUrl: "sandbox:/mnt/data/package.zip",
          filename: "ignored.bin",
          label: "package.zip",
        },
      ],
    });

    expect(result.saved).toBe(true);
    expect(result.fileCount).toBe(1);
    expect(result.savedFiles).toHaveLength(1);
    expect(result.savedFiles[0]).toMatchObject({
      kind: "file",
      label: "package.zip",
      mimeType: "application/zip",
      sourceUrl: "sandbox:/mnt/data/package.zip",
      sandboxUrl: "sandbox:/mnt/data/package.zip",
      filename: "package.zip",
    });
    expect(result.savedFiles[0]?.path).toBe(
      path.join(tmpHome, "sessions", "file-session", "artifacts", "package.zip"),
    );
    await expect(fs.readFile(result.savedFiles[0]!.path)).resolves.toEqual(Buffer.from([9, 8, 7]));
  });

  test("removes only owned artifacts when final page affinity fails", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-files-affinity-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://chatgpt.com/backend-api/files/file_package/download",
      headers: { get: () => null },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    } as unknown as Response);
    const artifactDir = path.join(tmpHome, "sessions", "affinity-session", "artifacts");
    const concurrentPath = path.join(artifactDir, "concurrent.bin");
    const assertPageAffinity = vi.fn(async (action: string) => {
      if (action === "downloadable file artifact final return") {
        await fs.writeFile(concurrentPath, "concurrent");
        throw new Error("conversation changed");
      }
    });
    await expect(
      saveChatGptDownloadableFiles({
        Network: network,
        sessionId: "affinity-session",
        assertPageAffinity,
        files: [
          {
            url: "https://chatgpt.com/backend-api/files/file_package/download",
            filename: "package.bin",
          },
        ],
      }),
    ).rejects.toThrow(/conversation changed/i);
    await expect(fs.readdir(artifactDir)).resolves.toEqual(["concurrent.bin"]);
    await expect(fs.readFile(concurrentPath, "utf8")).resolves.toBe("concurrent");
  });

  test("saves sandbox-only references through the ChatGPT sandbox download endpoint", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-sandbox-file-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Fsource.tar.gz",
      headers: {
        get: (name: string) => {
          if (name === "content-type") return "application/gzip";
          if (name === "content-disposition") return 'attachment; filename="source.tar.gz"';
          return null;
        },
      },
      arrayBuffer: async () => Uint8Array.from([3, 2, 1]).buffer,
    } as Response);

    const result = await saveChatGptDownloadableFiles({
      Network: network,
      sessionId: "file-session",
      files: [
        {
          url: "sandbox:/mnt/data/source.tar.gz",
          sandboxUrl: "sandbox:/mnt/data/source.tar.gz",
          filename: "source.tar.gz",
        },
      ],
    });

    expect(result.saved).toBe(true);
    expect(result.fileCount).toBe(1);
    expect(result.savedFiles[0]).toMatchObject({
      kind: "file",
      filename: "source.tar.gz",
      sourceUrl: "sandbox:/mnt/data/source.tar.gz",
      sandboxUrl: "sandbox:/mnt/data/source.tar.gz",
      validation: { type: "generic", ok: true },
    });
    expect(result.savedFiles[0]?.path).toBe(
      path.join(tmpHome, "sessions", "file-session", "artifacts", "source.tar.gz"),
    );
    const [fetchUrl, fetchOptions] = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(fetchUrl)).toBe(
      "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Fsource.tar.gz",
    );
    expect(fetchOptions).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          cookie: "__Secure-next-auth.session-token=abc",
        }),
      }),
    );
  });

  test("does not forward ChatGPT cookies across external redirects", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-redirect-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        statusText: "Found",
        url: "https://chatgpt.com/backend-api/files/file_csv/download",
        headers: {
          get: (name: string) =>
            name === "location" ? "https://cdn.example.com/generated/report.csv" : null,
        },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        url: "https://cdn.example.com/generated/report.csv",
        headers: { get: () => null },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      } as unknown as Response);

    const result = await saveChatGptDownloadableFiles({
      Network: network,
      sessionId: "file-session",
      files: [
        {
          url: "https://chatgpt.com/backend-api/files/file_csv/download",
          downloadUrl: "https://chatgpt.com/backend-api/files/file_csv/download",
          filename: "report.csv",
        },
      ],
    });

    expect(result.savedFiles).toHaveLength(1);
    const firstHeaders = vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    const secondHeaders = vi.mocked(globalThis.fetch).mock.calls[1]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(firstHeaders.cookie).toBe("__Secure-next-auth.session-token=abc");
    expect(secondHeaders.cookie).toBeUndefined();
  });

  test("does not fetch unsafe sandbox paths", async () => {
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn();

    const result = await saveChatGptDownloadableFiles({
      Network: network,
      sessionId: "file-session",
      files: [
        {
          url: "sandbox:/mnt/data/../secret.txt",
          sandboxUrl: "sandbox:/mnt/data/../secret.txt",
          filename: "secret.txt",
        },
      ],
    });

    expect(result.saved).toBe(false);
    expect(result.fileCount).toBe(1);
    expect(result.errors[0]).toContain("no ChatGPT download URL found");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("collectChatGptFileArtifacts", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    setOracleHomeDirOverrideForTest(null);
  });

  test("rejects a retarget before reading downloadable file DOM", async () => {
    const retargeted = new Error(
      "ChatGPT conversation changed before downloadable file artifact collection.",
    );
    const assertPageAffinity = vi.fn(async () => {
      throw retargeted;
    });
    const runtime = { evaluate: vi.fn() } as unknown as ChromeClient["Runtime"];

    await expect(
      collectChatGptFileArtifacts({
        Runtime: runtime,
        Network: {} as ChromeClient["Network"],
        expectedConversationId: "expected-conversation",
        assertPageAffinity,
      }),
    ).rejects.toBe(retargeted);
    expect(runtime.evaluate).not.toHaveBeenCalled();
  });

  test("discovers and saves downloadable file artifacts for a browser session", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-collect-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              url: "https://chatgpt.com/backend-api/files/file_wheel/download",
              downloadUrl: "https://chatgpt.com/backend-api/files/file_wheel/download",
              sandboxUrl: "sandbox:/mnt/data/pkg.whl",
              filename: "pkg.whl",
            },
          ],
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://chatgpt.com/backend-api/files/file_wheel/download",
      headers: {
        get: (name: string) => (name === "content-type" ? "application/octet-stream" : null),
      },
      arrayBuffer: async () => Uint8Array.from([1, 3, 5]).buffer,
    } as unknown as Response);

    const result = await collectChatGptFileArtifacts({
      Runtime: runtime,
      Network: network,
      sessionId: "collect-session",
    });

    expect(result.fileCount).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.savedFiles).toHaveLength(1);
    expect(result.savedFiles[0]?.path).toBe(
      path.join(tmpHome, "sessions", "collect-session", "artifacts", "pkg.whl"),
    );
  });

  test("does not poll download buttons when no file candidates are found", async () => {
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: { value: [] },
      }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({ cookies: [] }),
    } as unknown as ChromeClient["Network"];
    const page = {
      setDownloadBehavior: vi.fn().mockResolvedValue({}),
    } as unknown as ChromeClient["Page"];
    const logger = vi.fn();

    const result = await collectChatGptFileArtifacts({
      Page: page,
      Runtime: runtime,
      Network: network,
      sessionId: "collect-session",
      answerText: "Plain answer with no downloadable files.",
      logger,
    });

    expect(result).toEqual({ files: [], savedFiles: [], fileCount: 0 });
    expect(page.setDownloadBehavior).not.toHaveBeenCalled();
    expect(runtime.evaluate).toHaveBeenCalledTimes(1);
    expect(logger).not.toHaveBeenCalledWith(
      expect.stringContaining("Auto-save for downloadable files failed"),
    );
  });
  test("cleans private browser downloads after an in-page affinity exception", async () => {
    const destinationDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-download-staging-"));
    const concurrentPath = path.join(destinationDir, "concurrent.txt");
    await fs.writeFile(concurrentPath, "keep");
    let browserDownloadDir = "";
    const client = {
      send: vi.fn(async (_method: string, { downloadPath }: { downloadPath: string }) => {
        browserDownloadDir = downloadPath;
      }),
    } as unknown as ChromeClient;
    const runtime = {
      evaluate: vi.fn(async () => {
        await fs.writeFile(path.join(browserDownloadDir, "download.csv"), "new");
        return { result: { value: [] }, exceptionDetails: { text: "affinity changed" } };
      }),
    } as unknown as ChromeClient["Runtime"];

    try {
      await expect(
        saveAssistantDownloadButtonArtifacts({
          Client: client,
          Runtime: runtime,
          downloadPath: destinationDir,
          files: [],
        }),
      ).rejects.toThrow(/in-page affinity guard/i);
      await expect(fs.readFile(concurrentPath, "utf8")).resolves.toBe("keep");
      await expect(fs.readdir(destinationDir)).resolves.toEqual(["concurrent.txt"]);
    } finally {
      await fs.rm(destinationDir, { recursive: true, force: true });
    }
  });

  test("discovers sandbox links from captured answer markdown when DOM anchors are absent", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-text-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const csv = "name,value\nalpha,1\nbeta,2\n";
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: [] } })
        .mockResolvedValueOnce({
          result: {
            value: {
              ok: true,
              status: 200,
              statusText: "OK",
              url: "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Foracle_pr245_file_artifact_smoke.csv",
              contentDisposition: null,
              contentType: "text/csv",
              base64: Buffer.from(csv).toString("base64"),
            },
          },
        }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn();

    const result = await collectChatGptFileArtifacts({
      Runtime: runtime,
      Network: network,
      sessionId: "collect-session",
      answerText:
        "CHECK_FILE_ARTIFACT_OK — [oracle_pr245_file_artifact_smoke.csv](sandbox:/mnt/data/oracle_pr245_file_artifact_smoke.csv)",
    });

    expect(result.fileCount).toBe(1);
    expect(result.files[0]).toMatchObject({
      sandboxUrl: "sandbox:/mnt/data/oracle_pr245_file_artifact_smoke.csv",
      filename: "oracle_pr245_file_artifact_smoke.csv",
    });
    expect(result.savedFiles[0]).toMatchObject({
      kind: "file",
      filename: "oracle_pr245_file_artifact_smoke.csv",
      sourceUrl: "sandbox:/mnt/data/oracle_pr245_file_artifact_smoke.csv",
      mimeType: "text/csv",
    });
    expect(result.savedFiles[0]?.path).toBe(
      path.join(
        tmpHome,
        "sessions",
        "collect-session",
        "artifacts",
        "oracle_pr245_file_artifact_smoke.csv",
      ),
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(runtime.evaluate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        awaitPromise: true,
        returnByValue: true,
      }),
    );
  });

  test("reports sanitized direct sandbox fetch diagnostics when no browser-host file is saved", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-diagnostics-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const logger = vi.fn();
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: [] } })
        .mockResolvedValueOnce({
          result: {
            value: {
              ok: false,
              status: 403,
              statusText: "Forbidden",
              url: "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Fresult.zip&token=secret-token",
              contentDisposition: null,
              contentType: "application/json",
              base64: Buffer.from(
                '{"error":"missing token abc123","signed_url":"https://example.com/private?sig=secret"}',
              ).toString("base64"),
            },
          },
        }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({ cookies: [] }),
    } as unknown as ChromeClient["Network"];

    const result = await collectChatGptFileArtifacts({
      Runtime: runtime,
      Network: network,
      sessionId: "collect-session",
      answerText: "[zip](sandbox:/mnt/data/result.zip)",
      logger,
    });

    expect(result.fileCount).toBe(1);
    expect(result.savedFiles).toHaveLength(0);
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("status=403"));
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("contentType=application/json"));
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("finalUrlKind=chatgpt-sandbox-download"),
    );
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("bodyKind=json"));
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining("bridge artifact-ready will not be emitted"),
    );
    const logText = vi
      .mocked(logger)
      .mock.calls.map(([message]) => String(message))
      .join("\n");
    expect(logText).not.toContain("secret-token");
    expect(logText).not.toContain("sig=secret");
    expect(logText).not.toContain("abc123");
  });

  test("falls back to assistant download buttons when sandbox download URL is not fetchable", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-button-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const sessionId = "collect-session";
    const artifactsDir = path.join(tmpHome, "sessions", sessionId, "artifacts");
    const filename = "oracle_pr245_file_artifact_smoke_out.csv";
    const csv = "name,value\nalpha,1\nbeta,2\n";
    let browserDownloadDir = "";
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({ result: { value: [] } })
        .mockResolvedValueOnce({
          result: {
            value: {
              ok: false,
              status: 404,
              statusText: "Not Found",
              url: "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Foracle_pr245_file_artifact_smoke_out.csv",
              contentDisposition: null,
              contentType: "application/json",
              base64: Buffer.from('{"detail":"Not Found"}').toString("base64"),
            },
          },
        })
        .mockImplementationOnce(async ({ expression }: { expression?: string }) => {
          const fallbackExpression = String(expression ?? "");
          if (!fallbackExpression.includes("const ALLOW_GENERIC_DOWNLOAD_LABELS = true")) {
            return { result: { value: [] } };
          }
          await fs.writeFile(path.join(browserDownloadDir, filename), csv, "utf8");
          return {
            result: {
              value: [
                {
                  text: "Download",
                  ariaLabel: "",
                  testId: "download-files-turn-action-button",
                },
              ],
            },
          };
        }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    const page = {
      setDownloadBehavior: vi.fn(
        async ({
          behavior,
          downloadPath,
        }: {
          behavior: "allow" | "default";
          downloadPath?: string;
        }) => {
          if (behavior === "allow") browserDownloadDir = downloadPath ?? "";
        },
      ),
    } as unknown as ChromeClient["Page"];

    const result = await collectChatGptFileArtifacts({
      Page: page,
      Runtime: runtime,
      Network: network,
      sessionId,
      answerText:
        "CHECK_FILE_ARTIFACT_OK [download](sandbox:/mnt/data/oracle_pr245_file_artifact_smoke_out.csv)",
    });

    expect(result.fileCount).toBe(1);
    expect(result.savedFiles[0]).toMatchObject({
      kind: "file",
      filename,
      label: filename,
      mimeType: "text/csv",
      path: path.join(artifactsDir, filename),
    });
    expect(page.setDownloadBehavior).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "allow", downloadPath: browserDownloadDir }),
    );
    expect(path.dirname(browserDownloadDir)).toBe(artifactsDir);
    const fallbackExpression = String(vi.mocked(runtime.evaluate).mock.calls[2]?.[0]?.expression);
    expect(fallbackExpression).toContain("const ALLOW_GENERIC_DOWNLOAD_LABELS = true");
    expect(fallbackExpression).toContain("const MAX_CLICKS = 1");
    expect(fallbackExpression).toContain("download-files-turn-action-button");
  });

  test("clicks multiple assistant download buttons sequentially", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-sequential-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const sessionId = "collect-session";
    let browserDownloadDir = "";
    const runtime = {
      evaluate: vi.fn().mockImplementation(async ({ expression }: { expression?: string }) => {
        const clicked: Array<{ text: string; ariaLabel: string; testId: string }> = [];
        const writes: string[] = [];
        const text = String(expression ?? "");
        const hasA = text.includes('"a.txt"');
        const hasB = text.includes('"b.md"');
        const hasC = text.includes('"c.zip"');
        if (hasA && hasB && hasC) {
          writes.push("A.txt", "C.zip");
          clicked.push(
            { text: "Download A.txt", ariaLabel: "", testId: "" },
            { text: "Download B.md", ariaLabel: "", testId: "" },
            { text: "Download C.zip", ariaLabel: "", testId: "" },
          );
        } else if (hasA) {
          writes.push("A(1).txt");
          clicked.push({ text: "Download A.txt", ariaLabel: "", testId: "" });
        } else if (hasB) {
          writes.push("B(1).md");
          clicked.push({ text: "Download B.md", ariaLabel: "", testId: "" });
        } else if (hasC) {
          writes.push("C(1).zip");
          clicked.push({ text: "Download C.zip", ariaLabel: "", testId: "" });
        }
        await Promise.all(
          writes.map((filename) => fs.writeFile(path.join(browserDownloadDir, filename), filename)),
        );
        return { result: { value: clicked } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const page = {
      setDownloadBehavior: vi.fn(
        async ({
          behavior,
          downloadPath,
        }: {
          behavior: "allow" | "default";
          downloadPath?: string;
        }) => {
          if (behavior === "allow") browserDownloadDir = downloadPath ?? "";
        },
      ),
    } as unknown as ChromeClient["Page"];

    const savedFiles = await saveAssistantDownloadButtonArtifacts({
      Page: page,
      Runtime: runtime,
      sessionId,
      files: [
        {
          url: "sandbox:/mnt/data/A.txt",
          sandboxUrl: "sandbox:/mnt/data/A.txt",
          filename: "A.txt",
        },
        { url: "sandbox:/mnt/data/B.md", sandboxUrl: "sandbox:/mnt/data/B.md", filename: "B.md" },
        {
          url: "sandbox:/mnt/data/C.zip",
          sandboxUrl: "sandbox:/mnt/data/C.zip",
          filename: "C.zip",
        },
      ],
    });

    expect(savedFiles.map((file) => file.filename).sort()).toEqual(["A.txt", "B.md", "C.zip"]);
    expect(runtime.evaluate).toHaveBeenCalledTimes(3);
    for (const call of vi.mocked(runtime.evaluate).mock.calls) {
      const expression = String(call[0]?.expression ?? "");
      expect(expression).not.toContain('"a.txt","b.md","c.zip"');
    }
  });

  test("restores browser download behavior and publishes by exclusive copy without clobbering", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-publish-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const sessionId = "collect-session";
    const artifactsDir = path.join(tmpHome, "sessions", sessionId, "artifacts");
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.writeFile(path.join(artifactsDir, "report.csv"), "existing", "utf8");
    let browserDownloadDir = "";
    let restoredWhileStagingExisted = false;
    const runtime = {
      evaluate: vi.fn(async () => {
        await fs.writeFile(path.join(browserDownloadDir, "report.csv"), "new", "utf8");
        return { result: { value: [{ text: "Download report.csv", ariaLabel: "", testId: "" }] } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const page = {
      setDownloadBehavior: vi.fn(
        async ({
          behavior,
          downloadPath,
        }: {
          behavior: "allow" | "default";
          downloadPath?: string;
        }) => {
          if (behavior === "allow") {
            browserDownloadDir = downloadPath ?? "";
            return;
          }
          restoredWhileStagingExisted = await fs
            .stat(browserDownloadDir)
            .then(() => true)
            .catch(() => false);
        },
      ),
    } as unknown as ChromeClient["Page"];
    const linkSpy = vi.spyOn(fs, "link");

    const savedFiles = await saveAssistantDownloadButtonArtifacts({
      Page: page,
      Runtime: runtime,
      sessionId,
      files: [
        {
          url: "sandbox:/mnt/data/report.csv",
          sandboxUrl: "sandbox:/mnt/data/report.csv",
          filename: "report.csv",
        },
      ],
    });

    expect(savedFiles.map((file) => file.filename)).toEqual(["report-2.csv"]);
    await expect(fs.readFile(path.join(artifactsDir, "report.csv"), "utf8")).resolves.toBe(
      "existing",
    );
    await expect(fs.readFile(path.join(artifactsDir, "report-2.csv"), "utf8")).resolves.toBe("new");
    expect(linkSpy).not.toHaveBeenCalledWith(
      expect.any(String),
      path.join(artifactsDir, "report-2.csv"),
    );
    expect(page.setDownloadBehavior).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ behavior: "allow", downloadPath: browserDownloadDir }),
    );
    expect(page.setDownloadBehavior).toHaveBeenNthCalledWith(2, { behavior: "default" });
    expect(restoredWhileStagingExisted).toBe(true);
    await expect(fs.stat(browserDownloadDir)).rejects.toThrow();
  });

  test("keeps browser download staging when restoring default behavior fails", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-reset-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const browserId = `reset-${path.basename(tmpHome)}`;
    const lockScope = { browserId };
    const lockPath = resolveBrowserDownloadBehaviorLockPath(lockScope);
    let browserDownloadDir = "";
    const logger = vi.fn();
    const runtime = {
      evaluate: vi.fn(async () => {
        await fs.writeFile(path.join(browserDownloadDir, "report.csv"), "new", "utf8");
        return { result: { value: [{ text: "Download report.csv", ariaLabel: "", testId: "" }] } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const page = {
      setDownloadBehavior: vi.fn(
        async ({
          behavior,
          downloadPath,
        }: {
          behavior: "allow" | "default";
          downloadPath?: string;
        }) => {
          if (behavior === "allow") {
            browserDownloadDir = downloadPath ?? "";
            return;
          }
          throw new Error("reset failed");
        },
      ),
    } as unknown as ChromeClient["Page"];

    try {
      const savedFiles = await saveAssistantDownloadButtonArtifacts({
        Page: page,
        Runtime: runtime,
        logger,
        downloadBehaviorLockScope: lockScope,
        sessionId: "collect-session",
        files: [
          {
            url: "sandbox:/mnt/data/report.csv",
            sandboxUrl: "sandbox:/mnt/data/report.csv",
            filename: "report.csv",
          },
        ],
      });

      expect(savedFiles).toHaveLength(1);
      await expect(fs.stat(browserDownloadDir)).resolves.toMatchObject({});
      await expect(fs.stat(lockPath)).resolves.toMatchObject({});
      await expect(fs.stat(`${lockPath}.poison`)).resolves.toMatchObject({});
      await expect(
        acquireBrowserDownloadBehaviorLock(lockScope, { timeoutMs: 50, pollMs: 5 }),
      ).rejects.toThrow(/restart Chrome/i);
      const restartedBrowserLock = await acquireBrowserDownloadBehaviorLock(
        { browserId: `${browserId}-replacement` },
        { timeoutMs: 50, pollMs: 5 },
      );
      await restartedBrowserLock.release();
      expect(logger).toHaveBeenCalledWith(
        "[browser] Preserved browser download staging after reset failure.",
      );
    } finally {
      await fs.rm(lockPath, { force: true });
      await fs.rm(`${lockPath}.poison`, { force: true });
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  test("serializes browser-wide download behavior through reset across concurrent fallbacks", async () => {
    const firstDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-download-first-"));
    const secondDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-download-second-"));
    const events: string[] = [];
    let releaseFirstClick!: () => void;
    let signalFirstClick!: () => void;
    const firstClickGate = new Promise<void>((resolve) => {
      releaseFirstClick = resolve;
    });
    const firstClickStarted = new Promise<void>((resolve) => {
      signalFirstClick = resolve;
    });
    const client = {
      send: vi.fn(
        async (
          _method: string,
          { behavior }: { behavior: "allow" | "default"; downloadPath?: string },
        ) => {
          events.push(behavior);
        },
      ),
    } as unknown as ChromeClient;
    const firstRuntime = {
      evaluate: vi.fn(async () => {
        events.push("first-click");
        signalFirstClick();
        await firstClickGate;
        return { result: { value: [{ text: "Download", ariaLabel: "", testId: "" }] } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const secondRuntime = {
      evaluate: vi.fn(async () => {
        events.push("second-click");
        return { result: { value: [{ text: "Download", ariaLabel: "", testId: "" }] } };
      }),
    } as unknown as ChromeClient["Runtime"];

    const first = saveAssistantDownloadButtonArtifacts({
      Client: client,
      Runtime: firstRuntime,
      downloadPath: firstDir,
      downloadWaitMs: 0,
    });
    await firstClickStarted;
    const second = saveAssistantDownloadButtonArtifacts({
      Client: client,
      Runtime: secondRuntime,
      downloadPath: secondDir,
      downloadWaitMs: 0,
    });
    try {
      expect(secondRuntime.evaluate).not.toHaveBeenCalled();
      releaseFirstClick();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(events).toEqual([
        "allow",
        "first-click",
        "default",
        "allow",
        "second-click",
        "default",
      ]);
      expect(firstResult.retainedStagingDir).toBeUndefined();
      expect(secondResult.retainedStagingDir).toBeUndefined();
      await expect(fs.readdir(firstDir)).resolves.toEqual([]);
      await expect(fs.readdir(secondDir)).resolves.toEqual([]);
    } finally {
      releaseFirstClick();
      await Promise.allSettled([first, second]);
      await fs.rm(firstDir, { recursive: true, force: true });
      await fs.rm(secondDir, { recursive: true, force: true });
    }
  });
  test("reclaims a crashed process lock without deleting that run's staging", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-download-lock-recovery-"));
    try {
      const profileDir = path.join(root, "shared-profile");
      const artifactsDir = path.join(root, "artifacts");
      await fs.mkdir(profileDir, { recursive: true });
      await fs.mkdir(artifactsDir, { recursive: true });
      const crashedStagingDir = await fs.mkdtemp(path.join(artifactsDir, ".oracle-download-"));
      const crashedStagingFile = path.join(crashedStagingDir, "orphan.txt");
      await fs.writeFile(crashedStagingFile, "preserve", "utf8");

      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
      await once(child, "exit");
      if (!child.pid) throw new Error("Missing crashed lock owner pid");
      const lockPath = path.join(profileDir, "oracle-download-behavior.lock");
      await fs.writeFile(
        lockPath,
        JSON.stringify({
          pid: child.pid,
          lockId: "crashed-owner",
          createdAt: new Date().toISOString(),
        }),
      );

      let browserDownloadDir = "";
      const page = {
        setDownloadBehavior: vi.fn(
          async ({
            behavior,
            downloadPath,
          }: {
            behavior: "allow" | "default";
            downloadPath?: string;
          }) => {
            if (behavior === "allow") browserDownloadDir = downloadPath ?? "";
          },
        ),
      } as unknown as ChromeClient["Page"];
      const runtime = {
        evaluate: vi.fn(async () => {
          await fs.writeFile(path.join(browserDownloadDir, "replacement.txt"), "new", "utf8");
          return { result: { value: [{ text: "Download", ariaLabel: "", testId: "" }] } };
        }),
      } as unknown as ChromeClient["Runtime"];

      await expect(
        saveAssistantDownloadButtonArtifacts({
          Page: page,
          Runtime: runtime,
          downloadPath: artifactsDir,
          downloadWaitMs: 0,
          downloadBehaviorLockScope: { profileDir },
        }),
      ).resolves.toEqual([]);
      expect(page.setDownloadBehavior).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ behavior: "allow" }),
      );
      expect(page.setDownloadBehavior).toHaveBeenNthCalledWith(2, { behavior: "default" });
      await expect(fs.readFile(crashedStagingFile, "utf8")).resolves.toBe("preserve");
      await expect(fs.stat(lockPath)).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  test("keys shared Chrome locks by canonical browser identity across aliases and routes", () => {
    const canonicalPath = resolveBrowserDownloadBehaviorLockPath({
      browserId: "shared",
      profileDir: "/local-controller-profile",
    });
    for (const browserWSEndpoint of [
      "ws://localhost:9222/devtools/browser/shared",
      "ws://127.0.0.1:9222/devtools/browser/shared",
      "ws://[::1]:9222/devtools/browser/shared",
    ]) {
      expect(resolveBrowserDownloadBehaviorLockPath({ browserWSEndpoint })).toBe(canonicalPath);
    }
    expect(
      resolveBrowserDownloadBehaviorLockPath({ browserId: "shared", profileDir: "/other-profile" }),
    ).toBe(canonicalPath);
    expect(resolveBrowserDownloadBehaviorLockPath({ browserId: "other" })).not.toBe(canonicalPath);
    expect(() =>
      resolveBrowserDownloadBehaviorLockPath({
        browserId: "shared",
        browserWSEndpoint: "ws://127.0.0.1:9222/devtools/browser/other",
      }),
    ).toThrow(/does not match its WebSocket/i);
  });

  test("blocks a separate Oracle process on the same profile lock", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-download-lock-contention-"));
    const profileDir = path.join(root, "shared-profile");
    await fs.mkdir(profileDir, { recursive: true });
    const lockModule = pathToFileURL(
      path.resolve(process.cwd(), "src/browser/downloadBehaviorLock.ts"),
    ).href;
    const childScript = `
      import { acquireBrowserDownloadBehaviorLock } from ${JSON.stringify(lockModule)};
      const lock = await acquireBrowserDownloadBehaviorLock(
        { profileDir: ${JSON.stringify(profileDir)} },
        { timeoutMs: 3000, pollMs: 20 },
      );
      process.stdout.write("ready\\n");
      process.stdin.once("data", async () => {
        await lock.release();
        process.exit(0);
      });
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childScript],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "inherit"] },
    );
    if (!child.stdout || !child.stdin) throw new Error("Missing child stdio for lock contention");
    const childExited = once(child, "exit");
    let childOutput = "";
    const childReady = createDeferredPromise<void>();
    child.stdout.on("data", (chunk: Buffer) => {
      childOutput += chunk.toString();
      if (childOutput.includes("ready")) childReady.resolve();
    });
    child.once("error", childReady.reject);
    child.once("exit", (code) => {
      if (code !== null && !childOutput.includes("ready")) {
        childReady.reject(new Error(`lock owner exited before readiness (${code})`));
      }
    });
    try {
      await childReady.promise;
      const contenderWaiting = createDeferredPromise<void>();
      const contender = acquireBrowserDownloadBehaviorLock(
        { profileDir },
        {
          timeoutMs: 2000,
          pollMs: 20,
          logger: (message) => {
            if (message.includes("Waiting for browser-wide download capture lock")) {
              contenderWaiting.resolve();
            }
          },
        },
      );
      void contender.catch(contenderWaiting.reject);
      await contenderWaiting.promise;
      let contenderSettled = false;
      void contender.then(
        () => {
          contenderSettled = true;
        },
        () => {
          contenderSettled = true;
        },
      );
      expect(contenderSettled).toBe(false);
      child.stdin.write("release\n");
      const acquired = await contender;
      await acquired.release();
      await childExited;
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await childExited.catch(() => undefined);
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("preserves a browser-provided filename for a generic download endpoint", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-filename-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const sessionId = "collect-session";
    const artifactsDir = path.join(tmpHome, "sessions", sessionId, "artifacts");
    let browserDownloadDir = "";
    const runtime = {
      evaluate: vi.fn().mockImplementation(async () => {
        await fs.writeFile(path.join(browserDownloadDir, "report.csv"), "a,b\n1,2\n", "utf8");
        return { result: { value: [{ text: "Download", ariaLabel: "", testId: "" }] } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const page = {
      setDownloadBehavior: vi.fn(
        async ({
          behavior,
          downloadPath,
        }: {
          behavior: "allow" | "default";
          downloadPath?: string;
        }) => {
          if (behavior === "allow") browserDownloadDir = downloadPath ?? "";
        },
      ),
    } as unknown as ChromeClient["Page"];

    const savedFiles = await saveAssistantDownloadButtonArtifacts({
      Page: page,
      Runtime: runtime,
      sessionId,
      downloadWaitMs: 25,
      files: [
        {
          url: "https://chatgpt.com/backend-api/files/file_csv/download",
          downloadUrl: "https://chatgpt.com/backend-api/files/file_csv/download",
        },
      ],
    });

    expect(savedFiles).toHaveLength(1);
    expect(savedFiles[0]).toMatchObject({
      filename: "report.csv",
      label: "report.csv",
      mimeType: "text/csv",
    });
    await expect(fs.readFile(path.join(artifactsDir, "report.csv"), "utf8")).resolves.toBe(
      "a,b\n1,2\n",
    );
    await expect(fs.stat(path.join(artifactsDir, "download"))).rejects.toThrow();
  });

  test("stops after a timed-out download so a late completion cannot become the next file", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-missing-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const sessionId = "collect-session";
    const artifactsDir = path.join(tmpHome, "sessions", sessionId, "artifacts");
    const logger = vi.fn();
    let lateCompletion: Promise<void> | undefined;
    let browserDownloadDir = "";
    const runtime = {
      evaluate: vi.fn().mockImplementation(async ({ expression }: { expression?: string }) => {
        const text = String(expression ?? "");
        if (text.includes('"a.txt"')) {
          await fs.writeFile(path.join(browserDownloadDir, "A(1).txt"), "A");
          return { result: { value: [{ text: "Download A.txt", ariaLabel: "", testId: "" }] } };
        }
        if (text.includes('"b.md"')) {
          const partialPath = path.join(browserDownloadDir, "B.md.crdownload");
          await fs.writeFile(partialPath, "B");
          lateCompletion = new Promise<void>((resolve) => {
            setTimeout(() => {
              void fs
                .rename(partialPath, path.join(browserDownloadDir, "B.md"))
                .catch(() => undefined)
                .then(resolve);
            }, 275);
          });
          return { result: { value: [{ text: "Download B.md", ariaLabel: "", testId: "" }] } };
        }
        if (text.includes('"c.zip"')) {
          return { result: { value: [{ text: "Download C.zip", ariaLabel: "", testId: "" }] } };
        }
        return { result: { value: [] } };
      }),
    } as unknown as ChromeClient["Runtime"];
    const page = {
      setDownloadBehavior: vi.fn(
        async ({
          behavior,
          downloadPath,
        }: {
          behavior: "allow" | "default";
          downloadPath?: string;
        }) => {
          if (behavior === "allow") browserDownloadDir = downloadPath ?? "";
        },
      ),
    } as unknown as ChromeClient["Page"];

    const savedFiles = await saveAssistantDownloadButtonArtifacts({
      Page: page,
      Runtime: runtime,
      logger,
      sessionId,
      downloadWaitMs: 25,
      files: [
        {
          url: "sandbox:/mnt/data/A.txt",
          sandboxUrl: "sandbox:/mnt/data/A.txt",
          filename: "A.txt",
        },
        { url: "sandbox:/mnt/data/B.md", sandboxUrl: "sandbox:/mnt/data/B.md", filename: "B.md" },
        {
          url: "sandbox:/mnt/data/C.zip",
          sandboxUrl: "sandbox:/mnt/data/C.zip",
          filename: "C.zip",
        },
      ],
    });

    await lateCompletion;
    expect(savedFiles.map((file) => file.filename)).toEqual(["A.txt"]);
    expect(
      vi
        .mocked(runtime.evaluate)
        .mock.calls.some(([options]) => String(options?.expression ?? "").includes('"c.zip"')),
    ).toBe(false);
    await expect(fs.stat(path.join(artifactsDir, "B.md"))).rejects.toThrow();
    await expect(fs.stat(path.join(artifactsDir, "C.zip"))).rejects.toThrow();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining(
        "Download timed out for B.md; skipped remaining expected file(s) to avoid misassigning a late completion: C.zip",
      ),
    );
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining(
        "Download button fallback did not save expected file(s): B.md, C.zip",
      ),
    );
  });

  test("merges DOM and answer-text references for the same file", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-dedupe-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const runtime = {
      evaluate: vi.fn().mockResolvedValue({
        result: {
          value: [
            {
              url: "https://chatgpt.com/backend-api/files/file_csv/download",
              downloadUrl: "https://chatgpt.com/backend-api/files/file_csv/download",
              sandboxUrl: "sandbox:/mnt/data/report.csv",
              filename: "report.csv",
            },
          ],
        },
      }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      url: "https://chatgpt.com/backend-api/files/file_csv/download",
      headers: { get: () => null },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    } as unknown as Response);

    const result = await collectChatGptFileArtifacts({
      Runtime: runtime,
      Network: network,
      sessionId: "collect-session",
      answerText: "[Download](sandbox:/mnt/data/report.csv)",
    });

    expect(result.fileCount).toBe(1);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({
      downloadUrl: "https://chatgpt.com/backend-api/files/file_csv/download",
      sandboxUrl: "sandbox:/mnt/data/report.csv",
    });
    expect(result.savedFiles).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  test("scopes button fallback to failed files after a partial direct save", async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-chatgpt-file-partial-"));
    setOracleHomeDirOverrideForTest(tmpHome);
    const sessionId = "collect-session";
    const artifactsDir = path.join(tmpHome, "sessions", sessionId, "artifacts");
    let browserDownloadDir = "";
    const runtime = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce({
          result: {
            value: [
              {
                url: "https://chatgpt.com/backend-api/files/file_ok/download",
                downloadUrl: "https://chatgpt.com/backend-api/files/file_ok/download",
                filename: "ok.csv",
              },
              {
                url: "https://chatgpt.com/backend-api/files/file_missing/download",
                downloadUrl: "https://chatgpt.com/backend-api/files/file_missing/download",
                filename: "missing.csv",
              },
            ],
          },
        })
        .mockImplementationOnce(async () => {
          await fs.writeFile(
            path.join(browserDownloadDir, "missing.csv"),
            "missing,value\nrow,2\n",
            "utf8",
          );
          return { result: { value: [{ text: "missing.csv", ariaLabel: "", testId: "" }] } };
        }),
    } as unknown as ChromeClient["Runtime"];
    const network = {
      getCookies: vi.fn().mockResolvedValue({
        cookies: [{ name: "__Secure-next-auth.session-token", value: "abc" }],
      }),
    } as unknown as ChromeClient["Network"];
    const page = {
      setDownloadBehavior: vi.fn(
        async ({
          behavior,
          downloadPath,
        }: {
          behavior: "allow" | "default";
          downloadPath?: string;
        }) => {
          if (behavior === "allow") browserDownloadDir = downloadPath ?? "";
        },
      ),
    } as unknown as ChromeClient["Page"];
    globalThis.fetch = vi.fn().mockImplementation(async (url: URL | string) => {
      const missing = String(url).includes("file_missing");
      return {
        ok: !missing,
        status: missing ? 404 : 200,
        statusText: missing ? "Not Found" : "OK",
        url: String(url),
        headers: { get: () => null },
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      } as unknown as Response;
    });

    const result = await collectChatGptFileArtifacts({
      Page: page,
      Runtime: runtime,
      Network: network,
      sessionId,
    });

    expect(result.fileCount).toBe(2);
    expect(result.savedFiles).toHaveLength(2);
    expect(result.savedFiles.map((file) => file.filename)).toEqual(
      expect.arrayContaining(["ok.csv", "missing.csv"]),
    );
    expect(page.setDownloadBehavior).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: "allow", downloadPath: browserDownloadDir }),
    );
    expect(path.dirname(browserDownloadDir)).toBe(artifactsDir);
    expect(runtime.evaluate).toHaveBeenCalledTimes(2);
    const fallbackExpression = vi.mocked(runtime.evaluate).mock.calls[1]?.[0]?.expression;
    expect(fallbackExpression).toContain('"missing.csv"');
    expect(fallbackExpression).not.toContain('"ok.csv"');
    expect(fallbackExpression).toContain("const ALLOW_GENERIC_DOWNLOAD_LABELS = false");
  });

  test("normalizes only ChatGPT backend file URLs", () => {
    expect(__test__.normalizeChatGptDownloadUrl("https://example.com/file_1.zip")).toBeUndefined();
    expect(
      __test__.normalizeChatGptDownloadUrl("https://chatgpt.com/backend-api/me"),
    ).toBeUndefined();
    expect(
      __test__.normalizeChatGptDownloadUrl("https://chatgpt.com/backend-api/conversation/abc"),
    ).toBeUndefined();
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://chatgpt.com/backend-api/estuary/content?id=not_file",
      ),
    ).toBeUndefined();
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://chatgpt.com/backend-api/sandbox/download?path=%2Fetc%2Fpasswd",
      ),
    ).toBeUndefined();
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://chatgpt.com/backend-api/files/file_package/download",
      ),
    ).toBe("https://chatgpt.com/backend-api/files/file_package/download");
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Ffile.zip",
      ),
    ).toBe("https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Ffile.zip");
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://chatgpt.com/backend-api/estuary/content?id=file_abc123",
      ),
    ).toBe("https://chatgpt.com/backend-api/estuary/content?id=file_abc123");
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://files.chatgpt.com/backend-api/files/file_package/download",
      ),
    ).toBeUndefined();
    expect(
      __test__.normalizeChatGptDownloadUrl(
        "https://chatgpt.com:444/backend-api/files/file_package/download",
      ),
    ).toBeUndefined();
    expect(__test__.normalizeChatGptDownloadUrl("sandbox:/mnt/data/file.zip")).toBeUndefined();
    expect(__test__.normalizeSandboxUrl("sandbox:/mnt/data/file.zip")).toBe(
      "sandbox:/mnt/data/file.zip",
    );
    expect(__test__.normalizeSandboxUrl("sandbox:/mnt/data/../secret.txt")).toBeUndefined();
    expect(__test__.downloadUrlFromSandboxUrl("sandbox:/mnt/data/file.zip")).toBe(
      "https://chatgpt.com/backend-api/sandbox/download?path=%2Fmnt%2Fdata%2Ffile.zip",
    );
    expect(
      __test__.readTextDownloadableFiles(
        "[file](sandbox:/mnt/data/oracle_pr245_file_artifact_smoke.csv)",
      )[0],
    ).toMatchObject({
      sandboxUrl: "sandbox:/mnt/data/oracle_pr245_file_artifact_smoke.csv",
      filename: "oracle_pr245_file_artifact_smoke.csv",
    });
  });

  test("click expression prefers expected-label buttons across all turns", () => {
    const expectedButton = behaviorButton("Download file.csv");
    const newerGenericButton = behaviorButton("Download");
    const expression = __test__.buildClickAssistantDownloadButtonsExpression(
      undefined,
      ["file.csv"],
      true,
      { markClicked: true, maxClicks: 1 },
    );

    const clicked = evaluateClickExpression(expression, [
      assistantTurn([expectedButton]),
      assistantTurn([newerGenericButton]),
    ]);

    expect(clicked).toEqual([{ text: "Download file.csv", ariaLabel: "", testId: "" }]);
    expect(expectedButton.clickCount).toBe(1);
    expect(newerGenericButton.clickCount).toBe(0);
  });

  test("click expression preserves broad generic matching when no files are expected", () => {
    const behaviorGeneric = behaviorButton("Download image");
    const exactFallback = new FakeElement("", {
      "data-testid": "download-files-turn-action-button",
    });
    const expression = __test__.buildClickAssistantDownloadButtonsExpression(undefined, [], true);

    expect(
      evaluateClickExpression(expression, [
        assistantTurn([exactFallback]),
        assistantTurn([behaviorGeneric]),
      ]),
    ).toEqual([
      { text: "Download image", ariaLabel: "", testId: "" },
      { text: "", ariaLabel: "", testId: "download-files-turn-action-button" },
    ]);
    expect(behaviorGeneric.clickCount).toBe(1);
    expect(exactFallback.clickCount).toBe(1);
  });

  test("click expression ignores non-interactive elements with download metadata", () => {
    const metadata = new FakeElement(
      "Download private.zip",
      { "data-testid": "download-files-turn-action-button" },
      "",
      [],
      "DIV",
    );
    const expression = __test__.buildClickAssistantDownloadButtonsExpression(undefined, [], true);

    expect(evaluateClickExpression(expression, [assistantTurn([metadata])])).toEqual([]);
    expect(metadata.clickCount).toBe(0);
    expect(expression).not.toContain("'[data-testid]'");
    expect(expression).not.toContain("'[aria-label]'");
    expect(expression).not.toContain("'[title]'");
  });

  test("click expression can use a latest-turn sandbox anchor as a fallback control", () => {
    const anchor = anchorControl("", {
      href: "sandbox:/mnt/data/result.zip",
      download: "result.zip",
      "aria-label": "Download result.zip",
    });
    const expression = __test__.buildClickAssistantDownloadButtonsExpression(
      undefined,
      ["result.zip"],
      false,
      { markClicked: true, maxClicks: 1 },
    );

    expect(evaluateClickExpression(expression, [assistantTurn([anchor])])).toEqual([
      { text: "", ariaLabel: "Download result.zip", testId: "" },
    ]);
    expect(anchor.clickCount).toBe(1);
    expect(anchor.getAttribute("data-oracle-download-clicked")).toBe("true");
  });

  test("click expression ignores external download anchors", () => {
    const externalAnchor = anchorControl("Download result.zip", {
      href: "https://evil.example/download/result.zip",
      download: "result.zip",
    });
    const expression = __test__.buildClickAssistantDownloadButtonsExpression(
      undefined,
      ["result.zip"],
      true,
    );

    expect(evaluateClickExpression(expression, [assistantTurn([externalAnchor])])).toEqual([]);
    expect(externalAnchor.clickCount).toBe(0);
  });

  test("click expression allows ChatGPT file download anchors", () => {
    const chatGptAnchor = anchorControl("Download result.zip", {
      href: "https://chatgpt.com/backend-api/files/file_123/download",
      download: "result.zip",
    });
    const expression = __test__.buildClickAssistantDownloadButtonsExpression(
      undefined,
      ["result.zip"],
      false,
    );

    expect(evaluateClickExpression(expression, [assistantTurn([chatGptAnchor])])).toEqual([
      { text: "Download result.zip", ariaLabel: "", testId: "" },
    ]);
    expect(chatGptAnchor.clickCount).toBe(1);
  });

  test("click expression falls back to generic buttons and skips already-clicked ones", () => {
    const firstGeneric = behaviorButton("Download");
    const secondGeneric = new FakeElement("", {
      "data-testid": "download-files-turn-action-button",
    });
    const expression = (filename: string) =>
      __test__.buildClickAssistantDownloadButtonsExpression(undefined, [filename], true, {
        markClicked: true,
        maxClicks: 1,
      });
    const turns = [assistantTurn([firstGeneric, secondGeneric])];

    expect(evaluateClickExpression(expression("A.txt"), turns)).toEqual([
      { text: "Download", ariaLabel: "", testId: "" },
    ]);
    expect(firstGeneric.getAttribute("data-oracle-download-clicked")).toBe("true");
    expect(evaluateClickExpression(expression("B.md"), turns)).toEqual([
      { text: "", ariaLabel: "", testId: "download-files-turn-action-button" },
    ]);
    expect(secondGeneric.getAttribute("data-oracle-download-clicked")).toBe("true");
    expect(firstGeneric.clickCount).toBe(1);
    expect(secondGeneric.clickCount).toBe(1);
  });

  test("matches ChatGPT behavior download buttons with descriptive labels", () => {
    const fileExpression = __test__.buildAssistantDownloadableFilesExpression();
    const expression = __test__.buildClickAssistantDownloadButtonsExpression(undefined, [
      "oracle_pr245_file.csv",
    ]);
    const scopedExpression = __test__.buildClickAssistantDownloadButtonsExpression(
      undefined,
      ["oracle_pr245_file.csv"],
      false,
    );
    const oneClickExpression = __test__.buildClickAssistantDownloadButtonsExpression(
      undefined,
      ["oracle_pr245_file.csv"],
      true,
      { markClicked: true, maxClicks: 1 },
    );

    expect(fileExpression).toContain("files.push(...serializeFiles(messageRoot))");
    expect(fileExpression).not.toContain("if (files.length > 0) return files");
    expect(expression).toContain("/^download\\b/");
    expect(expression).not.toContain("/^download\b/");
    expect(expression).toContain('"oracle_pr245_file.csv"');
    expect(expression).toContain("const downloadLabel = 'download ' + label");
    expect(expression).toContain("value === downloadLabel");
    expect(expression).toContain('[data-testid^=\\"conversation-turn\\"]');
    expect(expression).not.toContain("document.querySelectorAll('button')");
    expect(expression).toContain("const expectedMatches = new Set()");
    expect(expression).toContain("controls.filter(expectedFileControl)");
    expect(expression).toContain("controls.filter(genericBehaviorButton)");
    expect(expression).toContain("controls.filter(genericFallbackButton)");
    expect(expression).toContain("expectedMatches.size > 0");
    expect(expression).toContain("genericBehaviorMatches.size > 0");
    expect(scopedExpression).toContain("const ALLOW_GENERIC_DOWNLOAD_LABELS = false");
    expect(oneClickExpression).toContain("const ALLOW_GENERIC_DOWNLOAD_LABELS = true");
    expect(oneClickExpression).toContain("const MARK_CLICKED = true");
    expect(oneClickExpression).toContain("const MAX_CLICKS = 1");
    expect(oneClickExpression).toContain("info.control.setAttribute(CLICKED_ATTRIBUTE, 'true')");
    const labels = __test__.resolveDownloadButtonLabels([
      {
        url: "sandbox:/mnt/data/oracle_pr245_file.csv",
        sandboxUrl: "sandbox:/mnt/data/oracle_pr245_file.csv",
        label: "Download the CSV",
      },
    ]);
    expect(labels).toHaveLength(2);
    expect(labels).toEqual(expect.arrayContaining(["oracle_pr245_file.csv", "download the csv"]));
  });
});
