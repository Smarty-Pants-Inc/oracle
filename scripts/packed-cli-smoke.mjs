import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
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

function assertWorkerMessage(message, type, token) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error(`packed removal worker emitted a non-object ${type} message`);
  }
  if (message.type !== type || message.token !== token) {
    throw new Error(`packed removal worker emitted an invalid ${type} message`);
  }
  const expectedKeys =
    type === "attested" ? "generationIdentity,rootIdentity,token,type" : "token,type";
  if (Object.keys(message).sort().join(",") !== expectedKeys) {
    throw new Error(`packed removal worker emitted an invalid ${type} message`);
  }
  if (type === "attested") {
    for (const identity of [message.rootIdentity, message.generationIdentity]) {
      if (
        !identity ||
        typeof identity !== "object" ||
        Array.isArray(identity) ||
        Object.keys(identity).sort().join(",") !== "birthtimeNs,device,inode" ||
        !Object.values(identity).every((value) => typeof value === "string" && value.length > 0)
      ) {
        throw new Error("packed removal worker emitted an invalid root attestation");
      }
    }
  }
}

function physicalDirectoryIdentity(directoryPath) {
  const stats = lstatSync(directoryPath, { bigint: true });
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    birthtimeNs: stats.birthtimeNs.toString(),
  };
}

function samePhysicalDirectoryIdentity(left, right) {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

async function readWorkerMessage(iterator, label) {
  let timeout;
  try {
    const next = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
      }),
    ]);
    if (next.done || typeof next.value !== "string") {
      throw new Error(`${label} closed stdout before completing its protocol`);
    }
    try {
      return JSON.parse(next.value);
    } catch {
      throw new Error(`${label} emitted malformed protocol JSON`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function smokePackedRemovalWorker(packageDir) {
  const workerPath = join(
    packageDir,
    "dist",
    "src",
    "browser",
    "filesystemLockDirectoryRemovalWorker.js",
  );
  accessSync(workerPath, constants.R_OK);

  const rootPath = mkdtempSync(join(tmpRoot, "removal-worker-"));
  mkdirSync(join(rootPath, "generation"));
  writeFileSync(join(rootPath, "generation", "payload"), "remove me");
  const rootIdentity = physicalDirectoryIdentity(rootPath);
  const generationIdentity = physicalDirectoryIdentity(join(rootPath, "generation"));
  const token = randomUUID();
  const worker = spawn(process.execPath, [workerPath, token], {
    cwd: rootPath,
    env: {
      ...npmEnvironment,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "",
      NODE_PATH: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!worker.stdin || !worker.stdout || !worker.stderr) {
    throw new Error("packed removal worker has unavailable stdio");
  }
  worker.stdin.on("error", () => undefined);
  let stderr = "";
  worker.stderr.setEncoding("utf8");
  worker.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const lines = createInterface({ input: worker.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  const exited = waitForExit(worker, "packed removal worker");

  try {
    const attestation = await readWorkerMessage(iterator, "packed removal worker attestation");
    assertWorkerMessage(attestation, "attested", token);
    if (
      !samePhysicalDirectoryIdentity(attestation.rootIdentity, rootIdentity) ||
      !samePhysicalDirectoryIdentity(attestation.generationIdentity, generationIdentity)
    ) {
      throw new Error("packed removal worker attested a different filesystem generation");
    }
    worker.stdin.end(`${JSON.stringify({ type: "go", token })}\n`);
    const completion = await readWorkerMessage(iterator, "packed removal worker completion");
    assertWorkerMessage(completion, "completed", token);
    const { code, signal } = await exited;
    if (code !== 0 || signal) {
      throw new Error(
        `packed removal worker did not terminate cleanly (${code ?? signal})${stderr ? `:\n${stderr}` : ""}`,
      );
    }
    if (readdirSync(rootPath).length !== 0) {
      throw new Error("packed removal worker completed without removing its bound generation");
    }
  } finally {
    lines.close();
    if (worker.exitCode === null && worker.signalCode === null) worker.kill();
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
  await smokePackedRemovalWorker(packageDir);
  await smokeMcp(oracleBin, ["oracle-mcp"], "packed oracle default-bin alias", installDir);
  console.log("Packed CLI, MCP dispatch, and removal-worker protocol smoke: ok");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
