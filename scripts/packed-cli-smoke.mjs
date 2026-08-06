import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = process.cwd();
const tmpRoot = mkdtempSync(join(tmpdir(), "oracle-packed-cli-"));
const npmUserConfigPath = join(tmpRoot, "user-npmrc");
const npmGlobalConfigPath = join(tmpRoot, "global-npmrc");
const isWindows = process.platform === "win32";
writeFileSync(npmUserConfigPath, "");
writeFileSync(npmGlobalConfigPath, "");
const npmEnvironment = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith("npm_config_")),
  ),
  NPM_CONFIG_GLOBALCONFIG: npmGlobalConfigPath,
  NPM_CONFIG_USERCONFIG: npmUserConfigPath,
  ORACLE_HOME_DIR: join(tmpRoot, "oracle-home"),
};

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    shell: options.shell ?? false,
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
  });
}

function assertPackedBin(packageDir, shimPath, name) {
  const { bin } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  const target = bin?.[name];
  if (typeof target !== "string") {
    throw new Error(`packed package has no ${name} bin target`);
  }

  accessSync(shimPath, constants.F_OK);
  if (!isWindows) {
    accessSync(shimPath, constants.X_OK);
  }
  const targetPath = join(packageDir, target);
  accessSync(targetPath, constants.F_OK);
  if (!isWindows) {
    accessSync(targetPath, constants.X_OK);
  }
  if (!readFileSync(targetPath, "utf8").startsWith("#!")) {
    throw new Error(`packed ${name} bin target is missing a shebang`);
  }
}

function waitForExit(proc, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} did not terminate within 5 seconds`)),
      5_000,
    );
    proc.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    proc.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function smokeMcp(command, args, label, cwd) {
  const proc = spawn(command, args, {
    cwd,
    env: npmEnvironment,
    shell: isWindows,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new Error(`${label} has unavailable stdio`);
  }

  let stderr = "";
  let initialized = false;
  let remainder = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = waitForExit(proc, label);
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "packed-cli-smoke", version: "1.0.0" },
    },
  };

  const initializedResponse = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${label} did not answer initialize${stderr ? `:\n${stderr}` : ""}`)),
      5_000,
    );
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    proc.once("error", fail);
    proc.once("exit", (code, signal) => {
      if (!initialized) {
        fail(
          new Error(
            `${label} exited before initialize (${code ?? signal})${stderr ? `:\n${stderr}` : ""}`,
          ),
        );
      }
    });
    proc.stdout.on("data", (chunk) => {
      remainder += chunk;
      const lines = remainder.split("\n");
      remainder = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          fail(new Error(`${label} emitted invalid JSON-RPC: ${line}`));
          return;
        }
        if (message?.id !== request.id) continue;
        const result = message.result;
        if (
          message.jsonrpc !== "2.0" ||
          !result ||
          typeof result.protocolVersion !== "string" ||
          typeof result.capabilities !== "object" ||
          result.serverInfo?.name !== "oracle-mcp"
        ) {
          fail(new Error(`${label} returned an invalid initialize response: ${line}`));
          return;
        }
        initialized = true;
        clearTimeout(timeout);
        resolve();
        return;
      }
    });
  });

  try {
    proc.stdin.write(`${JSON.stringify(request)}\n`);
    await initializedResponse;
    proc.stdin.end();
    const { code, signal } = await exited;
    if (code !== 0 || signal) {
      throw new Error(
        `${label} did not terminate cleanly (${code ?? signal})${stderr ? `:\n${stderr}` : ""}`,
      );
    }
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill();
    }
    await exited.catch(() => undefined);
  }
}

try {
  run("pnpm", ["--config.ignore-scripts=true", "pack", "--pack-destination", tmpRoot]);
  const tarball = readdirSync(tmpRoot).find((entry) => entry.endsWith(".tgz"));
  if (!tarball) {
    throw new Error("pnpm pack did not produce a .tgz file");
  }

  const installDir = join(tmpRoot, "install");
  mkdirSync(installDir);
  run("npm", ["init", "-y"], { cwd: installDir, env: npmEnvironment });
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(tmpRoot, tarball)], {
    cwd: installDir,
    env: npmEnvironment,
  });
  const packageDir = join(installDir, "node_modules", "@steipete", "oracle");
  const binDir = join(installDir, "node_modules", ".bin");
  const oracleBin = join(binDir, `oracle${isWindows ? ".cmd" : ""}`);
  const oracleMcpBin = join(binDir, `oracle-mcp${isWindows ? ".cmd" : ""}`);
  assertPackedBin(packageDir, oracleBin, "oracle");
  assertPackedBin(packageDir, oracleMcpBin, "oracle-mcp");

  const help = run(oracleBin, ["--help", "--verbose"], {
    cwd: installDir,
    env: npmEnvironment,
    shell: isWindows,
  });
  for (const expected of [
    "--no-azure",
    "--provider <provider>",
    "--http-timeout",
    "--allow-partial",
    "--preflight",
    "docs",
  ]) {
    if (!help.includes(expected)) {
      throw new Error(`packed CLI help is missing ${expected}`);
    }
  }
  await smokeMcp(oracleMcpBin, [], "packed oracle-mcp bin shim", installDir);
  await smokeMcp(oracleBin, ["oracle-mcp"], "packed oracle default-bin alias", installDir);
  console.log("Packed CLI help and MCP dispatch smoke: ok");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
