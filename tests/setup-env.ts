// Ensure API keys are present during tests so runOracle doesn't fail early when CI
// runs without real credentials.
import { lstat, mkdir, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  setWindowsPrivateDirectoryAuthorityOverrideForTest,
  setWindowsPrivateTreeAuthorityOverrideForTest,
} from "../src/remote/windowsPrivateTreeAcl.js";

// Keep ordinary tests in-process; dedicated Windows ACL tests explicitly select native authority.
setWindowsPrivateDirectoryAuthorityOverrideForTest(async (directoryPath) => {
  try {
    await mkdir(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const entry = await lstat(directoryPath);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Test private directory is not physical: ${directoryPath}`);
  }
});
setWindowsPrivateTreeAuthorityOverrideForTest(async (scope) => {
  if (scope.initializeRoots) {
    await mkdir(scope.integrityKeyDirectory, { recursive: true });
    await mkdir(scope.storeDirectory, { recursive: true });
    await mkdir(scope.authorityDirectory ?? scope.storeDirectory, { recursive: true });
  }
  const filePath = scope.initializeIntegrityKey ? scope.integrityKeyPath : scope.initializeFilePath;
  if (filePath) {
    const handle = await open(filePath, "wx");
    await handle.close();
  }
});

process.env.OPENAI_API_KEY ||= "sk-test";
process.env.GEMINI_API_KEY ||= "gm-test";
process.env.ORACLE_MIN_PROMPT_CHARS ||= "1";
// Avoid writing under ~/.oracle in constrained environments; keep test sessions isolated.
process.env.ORACLE_HOME_DIR ||= path.join(os.tmpdir(), `oracle-tests-${process.pid}`);
delete process.env.ORACLE_ENGINE;
delete process.env.ORACLE_REMOTE_HOST;
delete process.env.ORACLE_REMOTE_TOKEN;
