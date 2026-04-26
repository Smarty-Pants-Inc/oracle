import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { acquireLiveTestLock, releaseLiveTestLock } from "./liveLock.js";

const execFileAsync = promisify(execFile);
const LIVE =
  process.env.ORACLE_LIVE_TEST === "1" && process.env.ORACLE_LIVE_TEST_BROWSERBASE === "1";

(LIVE ? describe : describe.skip)("Browserbase live browser mode", () => {
  test(
    "runs the built CLI through Browserbase CDP without local Chrome metadata",
    async () => {
      const credentials = requireBrowserbaseCredentials();
      const oracleHome = await mkdtemp(path.join(os.tmpdir(), "oracle-browserbase-live-"));
      let preserveProof = true;

      await acquireLiveTestLock("browserbase");
      try {
        const token = `browserbase live ${Date.now()}`;
        const cliPath = path.join(process.cwd(), "dist", "bin", "oracle-cli.js");
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [
            cliPath,
            "--engine",
            "browser",
            "--browserbase",
            "--browser-model-strategy",
            "ignore",
            "--browserbase-timeout",
            "5m",
            "--prompt",
            `${token}\nReply with OK only.`,
            "--wait",
          ],
          {
            timeout: 8 * 60 * 1000,
            env: {
              ...process.env,
              // Keep this test isolated from the user's local Oracle history while still using
              // the remote Browserbase context for ChatGPT auth state.
              ORACLE_HOME_DIR: oracleHome,
              ORACLE_NO_DETACH: "1",
              ORACLE_DISABLE_KEYTAR: "1",
              ORACLE_BROWSERBASE_API_KEY: credentials.apiKey,
              ORACLE_BROWSERBASE_PROJECT_ID: credentials.projectId,
              ORACLE_BROWSERBASE_CONTEXT_ID: credentials.contextId ?? "",
            },
          },
        );
        const output = `${stdout}\n${stderr}`;
        expect(output.toLowerCase()).toContain("ok");

        const sessionsDir = path.join(oracleHome, "sessions");
        const [sessionId] = await readdir(sessionsDir);
        expect(sessionId).toBeTruthy();
        const proofMetadataPath = path.join(sessionsDir, sessionId as string, "meta.json");
        const meta = JSON.parse(await readFile(proofMetadataPath, "utf8")) as {
          browser?: {
            runtime?: {
              browserProvider?: string;
              browserbaseSessionId?: string;
              browserbaseProjectId?: string;
              browserbaseContextId?: string;
              chromeBrowserWSEndpoint?: string;
              chromePid?: number;
              userDataDir?: string;
            };
          };
        };
        const runtime = meta.browser?.runtime;
        console.info(
          `Browserbase live proof metadata: ${JSON.stringify({
            proofMetadataPath,
            runtime: sanitizeBrowserbaseRuntimeProof(runtime),
          })}`,
        );
        expect(runtime).toMatchObject({ browserProvider: "browserbase" });
        expect(runtime?.browserbaseProjectId).toBe(credentials.projectId);
        expect(runtime?.browserbaseSessionId).toBeTruthy();
        expect(runtime?.browserbaseContextId).toBeTruthy();
        if (credentials.contextId) {
          expect(runtime?.browserbaseContextId).toBe(credentials.contextId);
        }
        expect(runtime?.chromeBrowserWSEndpoint).toMatch(/^wss:\/\//);
        expect(runtime?.chromePid).toBeUndefined();
        expect(runtime?.userDataDir).toBeUndefined();
        preserveProof = false;
      } finally {
        await releaseLiveTestLock("browserbase");
        if (!preserveProof) {
          await rm(oracleHome, { recursive: true, force: true });
        } else {
          console.info(`Browserbase live proof preserved at: ${oracleHome}`);
        }
      }
    },
    8 * 60 * 1000,
  );
});

function requireBrowserbaseCredentials(): {
  apiKey: string;
  projectId: string;
  contextId?: string;
} {
  const apiKey = process.env.ORACLE_BROWSERBASE_API_KEY ?? process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.ORACLE_BROWSERBASE_PROJECT_ID ?? process.env.BROWSERBASE_PROJECT_ID;
  const contextId = process.env.ORACLE_BROWSERBASE_CONTEXT_ID ?? process.env.BROWSERBASE_CONTEXT_ID;
  if (!apiKey || !projectId) {
    throw new Error(
      "Browserbase live E2E requires ORACLE_BROWSERBASE_API_KEY/BROWSERBASE_API_KEY and ORACLE_BROWSERBASE_PROJECT_ID/BROWSERBASE_PROJECT_ID. ORACLE_BROWSERBASE_CONTEXT_ID/BROWSERBASE_CONTEXT_ID is optional and will be created on first run.",
    );
  }
  return { apiKey, projectId, contextId: contextId || undefined };
}

function sanitizeBrowserbaseRuntimeProof(
  runtime:
    | {
        browserProvider?: string;
        browserbaseSessionId?: string;
        browserbaseProjectId?: string;
        browserbaseContextId?: string;
        chromeBrowserWSEndpoint?: string;
        chromePid?: number;
        userDataDir?: string;
      }
    | undefined,
): {
  browserProvider?: string;
  browserbaseSessionIdPresent: boolean;
  browserbaseProjectIdPresent: boolean;
  browserbaseContextIdPresent: boolean;
  chromeBrowserWSEndpointScheme?: string;
  chromePidPresent: boolean;
  userDataDirPresent: boolean;
} {
  return {
    browserProvider: runtime?.browserProvider,
    browserbaseSessionIdPresent: Boolean(runtime?.browserbaseSessionId),
    browserbaseProjectIdPresent: Boolean(runtime?.browserbaseProjectId),
    browserbaseContextIdPresent: Boolean(runtime?.browserbaseContextId),
    chromeBrowserWSEndpointScheme: runtime?.chromeBrowserWSEndpoint?.split(":", 1)[0],
    chromePidPresent: runtime?.chromePid !== undefined,
    userDataDirPresent: runtime?.userDataDir !== undefined,
  };
}
