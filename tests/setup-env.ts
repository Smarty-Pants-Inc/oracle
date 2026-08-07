// Ensure API keys are present during tests so runOracle doesn't fail early when CI
// runs without real credentials.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.OPENAI_API_KEY ||= "sk-test";
process.env.GEMINI_API_KEY ||= "gm-test";
process.env.ORACLE_MIN_PROMPT_CHARS ||= "1";
// Avoid writing under ~/.oracle and stale PID-named directories in constrained environments.
if (!process.env.ORACLE_HOME_DIR) {
  const oracleHome = mkdtempSync(path.join(os.tmpdir(), "oracle-tests-"));
  process.env.ORACLE_HOME_DIR = oracleHome;
  process.once("exit", () => rmSync(oracleHome, { recursive: true, force: true }));
}
delete process.env.ORACLE_ENGINE;
delete process.env.ORACLE_REMOTE_HOST;
delete process.env.ORACLE_REMOTE_TOKEN;
