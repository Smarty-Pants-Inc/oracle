import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
      let releaseError: unknown;

      await acquireLiveTestLock("browserbase");
      try {
        const token = `browserbase live ${Date.now()}`;
        const cliPath = path.join(process.cwd(), "dist", "bin", "oracle-cli.js");
        const commandArgs = [
          cliPath,
          "--engine",
          "browser",
          "--model",
          "gpt-5.5",
          "--browserbase",
          "--browserbase-keep-alive",
          "--browser-no-cookie-sync",
          "--browser-model-strategy",
          "ignore",
          "--browserbase-timeout",
          "15m",
          "--browser-timeout",
          "10m",
          "--prompt",
          `${token}\nReply with OK only.`,
          "--wait",
        ];
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          // Keep this test isolated from local Chrome auth; ChatGPT login must come from the
          // explicitly configured durable Browserbase context.
          ORACLE_HOME_DIR: oracleHome,
          ORACLE_NO_DETACH: "1",
          ORACLE_DISABLE_KEYTAR: "1",
          ORACLE_BROWSERBASE_API_KEY: credentials.apiKey,
          ORACLE_BROWSERBASE_PROJECT_ID: credentials.projectId,
          ORACLE_BROWSERBASE_CONTEXT_ID: credentials.contextId,
          ORACLE_BROWSERBASE_KEEP_ALIVE: "1",
        };
        delete env.VITEST;
        delete env.VITEST_POOL_ID;
        delete env.VITEST_WORKER_ID;
        let stdout = "";
        let stderr = "";
        try {
          const result = await execFileAsync(process.execPath, commandArgs, {
            timeout: 8 * 60 * 1000,
            env,
          });
          stdout = result.stdout;
          stderr = result.stderr;
        } catch (error) {
          await writeSanitizedProof(oracleHome, {
            phase: "cli-failed",
            command: `${process.execPath} ${commandArgs.map(redactProofText).join(" ")}`,
            requiredContextId: credentials.contextId,
            stdout: redactProofText(String((error as { stdout?: string }).stdout ?? "")),
            stderr: redactProofText(String((error as { stderr?: string }).stderr ?? "")),
            error: redactProofText((error as Error).message),
          });
          throw error;
        }
        const output = `${stdout}\n${stderr}`;
        await writeSanitizedProof(oracleHome, {
          phase: "cli-completed",
          requiredContextId: credentials.contextId,
          stdout: redactProofText(stdout),
          stderr: redactProofText(stderr),
        });
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
        const sanitizedProof = {
          proofMetadataPath,
          runtime: sanitizeBrowserbaseRuntimeProof(runtime),
        };
        await writeSanitizedProof(oracleHome, sanitizedProof);
        console.info(`Browserbase live proof metadata: ${JSON.stringify(sanitizedProof)}`);
        expect(runtime).toMatchObject({ browserProvider: "browserbase" });
        expect(runtime?.browserbaseProjectId).toBe(credentials.projectId);
        expect(runtime?.browserbaseSessionId).toBeTruthy();
        expect(runtime?.browserbaseContextId).toBe(credentials.contextId);
        expect(runtime?.chromeBrowserWSEndpoint).toMatch(/^wss:\/\//);
        expect(runtime?.chromePid).toBeUndefined();
        expect(runtime?.userDataDir).toBeUndefined();
        preserveProof = false;
      } finally {
        try {
          await releaseBrowserbaseSessionsFromProof(oracleHome, credentials);
          await assertNoRunningBrowserbaseSessions(credentials);
        } catch (error) {
          releaseError = error;
          preserveProof = true;
          console.info(
            `Browserbase live session release failed: ${redactProofText(
              error instanceof Error ? error.message : String(error),
            )}`,
          );
        } finally {
          await releaseLiveTestLock("browserbase");
        }
        if (!preserveProof) {
          await rm(oracleHome, { recursive: true, force: true });
        } else {
          console.info(`Browserbase live proof preserved at: ${oracleHome}`);
        }
      }
      if (releaseError) {
        throw releaseError;
      }
    },
    8 * 60 * 1000,
  );
});

function requireBrowserbaseCredentials(): {
  apiKey: string;
  projectId: string;
  contextId: string;
} {
  const apiKey = process.env.ORACLE_BROWSERBASE_API_KEY ?? process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.ORACLE_BROWSERBASE_PROJECT_ID ?? process.env.BROWSERBASE_PROJECT_ID;
  const contextId = process.env.ORACLE_BROWSERBASE_CONTEXT_ID ?? process.env.BROWSERBASE_CONTEXT_ID;
  if (!apiKey || !projectId || !contextId) {
    throw new Error(
      "Browserbase live E2E requires ORACLE_BROWSERBASE_API_KEY/BROWSERBASE_API_KEY, ORACLE_BROWSERBASE_PROJECT_ID/BROWSERBASE_PROJECT_ID, and ORACLE_BROWSERBASE_CONTEXT_ID/BROWSERBASE_CONTEXT_ID. The context must already be durable and authenticated for ChatGPT; this test will not create an unauthenticated context.",
    );
  }
  return { apiKey, projectId, contextId };
}

async function releaseBrowserbaseSessionsFromProof(
  oracleHome: string,
  credentials: { apiKey: string; projectId: string; contextId: string },
): Promise<void> {
  const sessionsDir = path.join(oracleHome, "sessions");
  const sessionIds = await readdir(sessionsDir).catch(() => []);
  const released: string[] = [];
  for (const sessionId of sessionIds) {
    const metadataPath = path.join(sessionsDir, sessionId, "meta.json");
    const meta = JSON.parse(await readFile(metadataPath, "utf8")) as {
      browser?: {
        runtime?: {
          browserProvider?: string;
          browserbaseSessionId?: string;
          browserbaseProjectId?: string;
          browserbaseContextId?: string;
        };
      };
    };
    const runtime = meta.browser?.runtime;
    const browserbaseSessionId = runtime?.browserbaseSessionId?.trim();
    if (
      runtime?.browserProvider !== "browserbase" ||
      !browserbaseSessionId ||
      runtime.browserbaseProjectId !== credentials.projectId ||
      runtime.browserbaseContextId !== credentials.contextId
    ) {
      continue;
    }
    const response = await fetch(
      `https://api.browserbase.com/v1/sessions/${encodeURIComponent(browserbaseSessionId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BB-API-Key": credentials.apiKey,
        },
        body: JSON.stringify({
          projectId: credentials.projectId,
          status: "REQUEST_RELEASE",
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Browserbase release for session ${browserbaseSessionId} failed with status ${response.status}.`,
      );
    }
    released.push(browserbaseSessionId);
  }
  if (released.length > 0) {
    console.info(`Browserbase live sessions released: ${released.join(", ")}`);
  }
}

async function assertNoRunningBrowserbaseSessions(credentials: {
  apiKey: string;
  projectId: string;
  contextId: string;
}): Promise<void> {
  let running = await listRunningBrowserbaseSessions(credentials);
  for (let attempt = 0; running.length > 0 && attempt < 20; attempt += 1) {
    await delay(1_000);
    running = await listRunningBrowserbaseSessions(credentials);
  }
  const proof = {
    checkedAt: new Date().toISOString(),
    projectId: credentials.projectId,
    contextId: credentials.contextId,
    runningSessionCount: running.length,
    runningSessionIds: running.map((session) => session.id),
  };
  console.info(`Browserbase zero-running-sessions proof: ${JSON.stringify(proof)}`);
  if (running.length > 0) {
    throw new Error(
      `Browserbase still has ${running.length} scoped running session(s): ${running
        .map((session) => session.id)
        .join(", ")}`,
    );
  }
}

async function listRunningBrowserbaseSessions(credentials: {
  apiKey: string;
  projectId: string;
  contextId: string;
}): Promise<Array<{ id: string; projectId?: string; contextId?: string; status?: string }>> {
  const response = await fetch("https://api.browserbase.com/v1/sessions?status=RUNNING", {
    headers: {
      "Content-Type": "application/json",
      "X-BB-API-Key": credentials.apiKey,
    },
  });
  if (!response.ok) {
    throw new Error(`Browserbase running-session check failed with status ${response.status}.`);
  }
  const sessions = (await response.json()) as Array<{
    id: string;
    projectId?: string;
    contextId?: string;
    status?: string;
  }>;
  return sessions.filter(
    (session) =>
      session.projectId === credentials.projectId && session.contextId === credentials.contextId,
  );
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
  browserbaseSessionId?: string;
  browserbaseProjectId?: string;
  browserbaseContextId?: string;
  chromeBrowserWSEndpoint?: { scheme?: string; host?: string };
  chromePidPresent: boolean;
  userDataDirPresent: boolean;
} {
  const endpoint = runtime?.chromeBrowserWSEndpoint
    ? safeUrlParts(runtime.chromeBrowserWSEndpoint)
    : undefined;
  return {
    browserProvider: runtime?.browserProvider,
    browserbaseSessionId: runtime?.browserbaseSessionId,
    browserbaseProjectId: runtime?.browserbaseProjectId,
    browserbaseContextId: runtime?.browserbaseContextId,
    chromeBrowserWSEndpoint: endpoint,
    chromePidPresent: runtime?.chromePid !== undefined,
    userDataDirPresent: runtime?.userDataDir !== undefined,
  };
}

async function writeSanitizedProof(
  oracleHome: string,
  proof: Record<string, unknown>,
): Promise<void> {
  const proofPath = path.join(oracleHome, "browserbase-live-proof.json");
  await writeFile(proofPath, `${JSON.stringify({ proofPath, ...proof }, null, 2)}\n`, "utf8");
  console.info(`Browserbase live sanitized proof written to: ${proofPath}`);
}

function safeUrlParts(raw: string): { scheme?: string; host?: string } {
  try {
    const url = new URL(raw);
    return { scheme: url.protocol.replace(/:$/, ""), host: url.host };
  } catch {
    return { scheme: raw.split(":", 1)[0] };
  }
}

function redactProofText(raw: string): string {
  return raw.replace(/\b(?:wss|https):\/\/[^\s"']*browserbase[^\s"']*/g, (match) => {
    const parts = safeUrlParts(match);
    return `${parts.scheme ?? "redacted"}://${parts.host ?? "redacted"}/<redacted>`;
  });
}
