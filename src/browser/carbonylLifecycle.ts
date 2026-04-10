import type { LaunchedChrome } from "chrome-launcher";
import net from "node:net";
import type { BrowserLogger } from "./types.js";
import { verifyDevToolsReachable } from "./profileState.js";

const DEFAULT_CARBONYL_COLS = 140;
const DEFAULT_CARBONYL_ROWS = 40;
const DEFAULT_CARBONYL_STARTUP_TIMEOUT_MS = 30_000;
const OUTPUT_TAIL_LIMIT = 8_000;

type PtyHandle = {
  pid: number;
  write(data: string): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
};

export async function launchCarbonyl(
  {
    chromePath,
    chromeFlags,
    debugPort,
    host,
    url,
    userDataDir,
  }: {
    chromePath?: string | null;
    chromeFlags: string[];
    debugPort?: number | null;
    host: string;
    url: string;
    userDataDir: string;
  },
  logger: BrowserLogger,
): Promise<LaunchedChrome & { host?: string }> {
  const pty = await loadNodePty();
  const { file, args } = resolveCarbonylCommand(chromePath);
  const { cols, rows } = resolveViewport();
  const resolvedPort = await pickDebugPort(debugPort ?? undefined);
  const term = pty.spawn(
    file,
    [
      ...args,
      `--remote-debugging-port=${resolvedPort}`,
      `--user-data-dir=${userDataDir}`,
      ...chromeFlags,
      url,
    ],
    {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: buildPtyEnv(cols, rows),
    },
  ) as PtyHandle;

  let outputTail = "";
  let exitInfo: { exitCode: number; signal?: number } | null = null;
  const dataDisposable = term.onData((data) => {
    outputTail = `${outputTail}${data}`.slice(-OUTPUT_TAIL_LIMIT);
  });
  const exitDisposable = term.onExit((event) => {
    exitInfo = event;
  });

  try {
    await waitForDebuggerReady(term, host, resolvedPort, logger, () => exitInfo);
  } catch (error) {
    dataDisposable.dispose();
    exitDisposable.dispose();
    term.kill("SIGKILL");
    const details = formatExitDetails(exitInfo, outputTail);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Carbonyl failed to start: ${message}${details ? `\n${details}` : ""}`);
  }

  logger(`Launched Carbonyl (pid ${term.pid}) on port ${resolvedPort}`);
  const kill = async () => {
    dataDisposable.dispose();
    exitDisposable.dispose();
    term.kill("SIGTERM");
  };
  return {
    pid: term.pid,
    port: resolvedPort,
    process: undefined as unknown as NonNullable<LaunchedChrome["process"]>,
    remoteDebuggingPipes: false,
    kill,
    host,
  } as unknown as LaunchedChrome & { host?: string };
}

async function pickDebugPort(preferred?: number): Promise<number> {
  try {
    return await reservePort(preferred ?? 0);
  } catch {
    if (preferred !== undefined) {
      return reservePort(0);
    }
    throw new Error("unable to allocate a Carbonyl DevTools port");
  }
}

function resolveCarbonylCommand(chromePath?: string | null): { file: string; args: string[] } {
  const explicit = chromePath?.trim();
  if (explicit) {
    return { file: explicit, args: [] };
  }
  return {
    file: process.platform === "win32" ? "npx.cmd" : "npx",
    args: ["-y", "carbonyl"],
  };
}

function resolveViewport(): { cols: number; rows: number } {
  const cols = process.stdout.isTTY ? process.stdout.columns : undefined;
  const rows = process.stdout.isTTY ? process.stdout.rows : undefined;
  return {
    cols: Math.max(cols ?? DEFAULT_CARBONYL_COLS, 80),
    rows: Math.max(rows ?? DEFAULT_CARBONYL_ROWS, 24),
  };
}

async function waitForDebuggerReady(
  term: PtyHandle,
  host: string,
  port: number,
  logger: BrowserLogger,
  getExitInfo: () => { exitCode: number; signal?: number } | null,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DEFAULT_CARBONYL_STARTUP_TIMEOUT_MS) {
    const exitInfo = getExitInfo();
    if (exitInfo) {
      throw new Error(
        `process exited before DevTools became reachable (code ${exitInfo.exitCode}${exitInfo.signal ? `, signal ${exitInfo.signal}` : ""})`,
      );
    }
    const probe = await verifyDevToolsReachable({ host, port, attempts: 1, timeoutMs: 1_000 });
    if (probe.ok) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  logger(`Timed out waiting for Carbonyl DevTools at ${host}:${port}`);
  term.kill("SIGTERM");
  throw new Error(`timed out waiting for DevTools on ${host}:${port}`);
}

async function loadNodePty(): Promise<{
  spawn: (
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: Record<string, string>;
    },
  ) => PtyHandle;
}> {
  try {
    return (await import("@cdktf/node-pty-prebuilt-multiarch")).default as unknown as {
      spawn: (
        file: string,
        args: string[],
        options: {
          name: string;
          cols: number;
          rows: number;
          cwd: string;
          env: Record<string, string>;
        },
      ) => PtyHandle;
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      "Carbonyl launcher requires @cdktf/node-pty-prebuilt-multiarch to be installed and built. " +
        `Current error: ${message}`,
    );
  }
}

function buildPtyEnv(cols: number, rows: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.COLUMNS = String(cols);
  env.LINES = String(rows);
  return env;
}

function formatExitDetails(
  exitInfo: { exitCode: number; signal?: number } | null,
  outputTail: string,
): string {
  const cleaned = stripAnsi(outputTail)
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, " ")
    .trim();
  const exitLine = exitInfo
    ? `exit: code ${exitInfo.exitCode}${exitInfo.signal ? ` signal ${exitInfo.signal}` : ""}`
    : null;
  const tailLine = cleaned ? `output tail:\n${cleaned.slice(-1_500)}` : null;
  return [exitLine, tailLine].filter((value): value is string => Boolean(value)).join("\n");
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B\][^\u0007]*\u0007/g, "").replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function reservePort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const resolved =
        typeof address === "object" && address && typeof address.port === "number"
          ? address.port
          : port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(resolved);
      });
    });
  });
}
