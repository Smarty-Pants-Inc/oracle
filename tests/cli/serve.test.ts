import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test, vi } from "vitest";
import { readBridgeConnectionArtifact } from "../../src/bridge/connection.js";
import { runDirectServe } from "../../src/cli/serve.js";
import type {
  RemoteServerInstance,
  RemoteServerLifecycle,
  RemoteServerOptions,
} from "../../src/remote/server.js";

const execFileAsync = promisify(execFile);
const CLI_ENTRY = path.join(process.cwd(), "bin", "oracle-cli.ts");
const MODERN_TOKEN = "a".repeat(64);
const LEGACY_TOKEN = "b".repeat(64);

async function execCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", CLI_ENTRY, ...args],
      {
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: "/tmp/nonexistent-oracle-env",
        },
        timeout: 15_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message,
    };
  }
}

describe("direct oracle serve credentials", () => {
  test("publishes the generated server credential only through the private connection artifact", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oracle-direct-serve-"));
    const artifactPath = path.join(tempDir, "serve-connection.json");
    const logs: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((message) => {
      logs.push(String(message));
    });
    const serveRemote = vi.fn(
      async (
        options: RemoteServerOptions = {},
        lifecycle: RemoteServerLifecycle = {},
      ): Promise<void> => {
        expect(options).toMatchObject({
          host: "127.0.0.1",
          port: 9473,
          manualLoginDefault: true,
          manualLoginProfileDir: path.join(tempDir, "profile"),
        });
        expect(Object.hasOwn(options, "token")).toBe(false);
        expect(Object.hasOwn(options, "legacyToken")).toBe(false);
        await lifecycle.onReady?.({ port: 9473, token: MODERN_TOKEN });
      },
    );

    try {
      await runDirectServe(
        {
          host: "127.0.0.1",
          port: 9473,
          writeConnection: artifactPath,
          manualLogin: true,
          manualLoginProfileDir: path.join(tempDir, "profile"),
        },
        { serveRemote },
      );

      const artifact = await readBridgeConnectionArtifact(artifactPath);
      expect(artifact).toMatchObject({
        remoteHost: "127.0.0.1:9473",
        remoteToken: MODERN_TOKEN,
      });
      expect((await readFile(artifactPath, "utf8")).endsWith("\n")).toBe(true);
      if (process.platform !== "win32") {
        expect((await stat(artifactPath)).mode & 0o777).toBe(0o600);
      }
      expect(logs.join("\n")).toContain(artifactPath);
      expect(logs.join("\n")).not.toContain(MODERN_TOKEN);
      expect(serveRemote).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("closes the ready listener and removes the exact artifact when readiness display fails", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oracle-direct-serve-ready-failure-"));
    const artifactPath = path.join(tempDir, "serve-connection.json");
    const close = vi.fn(async (): Promise<void> => undefined);
    const server: RemoteServerInstance = { port: 9473, token: MODERN_TOKEN, close };
    const serveRemote = vi.fn(
      async (
        _options: RemoteServerOptions = {},
        lifecycle: RemoteServerLifecycle = {},
      ): Promise<void> => {
        try {
          await lifecycle.onReady?.(server);
        } catch (error) {
          await server.close();
          throw error;
        }
      },
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("injected readiness display failure");
    });

    try {
      const error = await runDirectServe(
        { port: 9473, writeConnection: artifactPath },
        { serveRemote },
      ).then(
        () => new Error("unsafe readiness publication unexpectedly succeeded"),
        (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))),
      );

      expect(error.message).toContain("injected readiness display failure");
      expect(error.message).not.toContain(MODERN_TOKEN);
      await expect(stat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(close).toHaveBeenCalledOnce();
      expect(log.mock.calls.flat().join("\n")).not.toContain(MODERN_TOKEN);
    } finally {
      log.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects a replaced preflight parent without publishing the secret and closes readiness", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "oracle-direct-serve-parent-race-"));
    const connectionParent = path.join(tempDir, "connection-parent");
    const movedParent = path.join(tempDir, "preflight-parent");
    const artifactPath = path.join(connectionParent, "serve-connection.json");
    const replacementMarker = path.join(connectionParent, "replacement-marker");
    await mkdir(connectionParent);
    const close = vi.fn(async (): Promise<void> => undefined);
    const server: RemoteServerInstance = { port: 9473, token: MODERN_TOKEN, close };
    const serveRemote = vi.fn(
      async (
        _options: RemoteServerOptions = {},
        lifecycle: RemoteServerLifecycle = {},
      ): Promise<void> => {
        await rename(connectionParent, movedParent);
        await mkdir(connectionParent);
        await writeFile(replacementMarker, "preserve\n", "utf8");
        try {
          await lifecycle.onReady?.(server);
        } catch (error) {
          await server.close();
          throw error;
        }
      },
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const error = await runDirectServe(
        { port: 9473, writeConnection: artifactPath },
        { serveRemote },
      ).then(
        () => new Error("replaced publication parent unexpectedly succeeded"),
        (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))),
      );

      expect(error.message).toMatch(/parent changed after preflight/i);
      expect(error.message).not.toContain(MODERN_TOKEN);
      await expect(readFile(replacementMarker, "utf8")).resolves.toBe("preserve\n");
      await expect(stat(artifactPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(path.join(movedParent, "serve-connection.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(close).toHaveBeenCalledOnce();
      expect(log.mock.calls.flat().join("\n")).not.toContain(MODERN_TOKEN);
    } finally {
      log.mockRestore();
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("rejects modern and legacy argv credentials without echoing them or starting the server", async () => {
    const serveRemote = vi.fn(async (): Promise<void> => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      for (const options of [{ token: MODERN_TOKEN }, { legacyToken: LEGACY_TOKEN }]) {
        const error = await runDirectServe(options, { serveRemote }).then(
          () => new Error("unsafe serve options unexpectedly succeeded"),
          (reason: unknown) => (reason instanceof Error ? reason : new Error(String(reason))),
        );
        expect(error.message).toMatch(/refuses credentials in process arguments/i);
        expect(error.message).not.toContain(MODERN_TOKEN);
        expect(error.message).not.toContain(LEGACY_TOKEN);
      }
      expect(serveRemote).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test("documents the private connection artifact and hidden rejected flags", async () => {
    const help = await execCli(["serve", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--write-connection <path>");
    expect(help.stdout).toContain("--token and --legacy-token are rejected");
    expect(help.stdout).not.toMatch(/^\s+--token\s/mu);
    expect(help.stdout).not.toMatch(/^\s+--legacy-token\s/mu);
  });

  test("rejects credential flags across global option and separator orderings", async () => {
    for (const [flag, secret] of [
      ["--token", MODERN_TOKEN],
      ["--legacy-token", LEGACY_TOKEN],
    ] as const) {
      for (const args of [
        ["serve", `${flag}=${secret}`],
        [`${flag}=${secret}`, "serve"],
        ["--model", "gpt-5.6-sol", "serve", flag, secret],
        ["--model", "gpt-5.6-sol", flag, secret, "serve"],
        ["--model=gpt-5.6-sol", "serve", `${flag}=${secret}`],
        ["serve", "--model", "gpt-5.6-sol", flag, secret],
        [flag, secret, "--model", "gpt-5.6-sol", "serve"],
        [flag, "--model", "gpt-5.6-sol", "serve"],
        ["serve", "--", flag, secret],
        ["--", "serve", flag, secret],
        [`${flag}=${secret}`, "--", "serve"],
        ["serve", flag],
      ]) {
        const rejected = await execCli(args);
        expect(rejected.code).toBe(1);
        expect(rejected.stderr).toMatch(/refuses credentials in process arguments/i);
        expect(`${rejected.stdout}\n${rejected.stderr}`).not.toContain(secret);
      }
    }
  }, 30_000);

  test("does not treat a global option value named serve as the subcommand", async () => {
    for (const [args, secret] of [
      [["--prompt", "serve", `--token=${MODERN_TOKEN}`], MODERN_TOKEN],
      [["--model", "serve", `--legacy-token=${LEGACY_TOKEN}`], LEGACY_TOKEN],
      [["--file", "serve", `--token=${MODERN_TOKEN}`], MODERN_TOKEN],
    ] as const) {
      const rejectedRootCommand = await execCli([...args]);
      expect(rejectedRootCommand.code).toBe(1);
      expect(rejectedRootCommand.stderr).not.toMatch(/oracle serve refuses credentials/i);
      expect(`${rejectedRootCommand.stdout}\n${rejectedRootCommand.stderr}`).not.toContain(secret);
    }

    for (const [flag, secret] of [
      ["--token", MODERN_TOKEN],
      ["--legacy-token", LEGACY_TOKEN],
    ] as const) {
      const bridgeHelp = await execCli([
        "--prompt",
        "serve",
        "bridge",
        "host",
        `${flag}=${secret}`,
        "--help",
      ]);
      expect(bridgeHelp.code).toBe(0);
      expect(bridgeHelp.stdout).toMatch(/Usage: oracle bridge host/i);
      expect(bridgeHelp.stderr).not.toMatch(/oracle serve refuses credentials/i);
    }
  }, 15_000);

  test("redacts legacy credentials from the vulnerable global-option perf trace ordering", async () => {
    const traceDir = await mkdtemp(path.join(os.tmpdir(), "oracle-serve-secret-trace-"));
    const tracePath = path.join(traceDir, "trace.json");
    try {
      const rejected = await execCli([
        "--model",
        "gpt-5.6-sol",
        "serve",
        `--legacy-token=${LEGACY_TOKEN}`,
        "--perf-trace",
        "--perf-trace-path",
        tracePath,
      ]);
      expect(rejected.code).toBe(1);
      expect(rejected.stderr).toMatch(/refuses credentials in process arguments/i);
      expect(`${rejected.stdout}\n${rejected.stderr}`).not.toContain(LEGACY_TOKEN);
      const trace = await readFile(tracePath, "utf8");
      expect(trace).toContain("[redacted]");
      expect(trace).not.toContain(LEGACY_TOKEN);
    } finally {
      await rm(traceDir, { recursive: true, force: true });
    }
  });
});
