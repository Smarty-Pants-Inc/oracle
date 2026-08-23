import {
  OracleArchiveRepairRequiredError,
  oracleCliExitCodeForError,
} from "../../src/cli/archiveRepair.js";

const mode = process.argv[2];

try {
  if (mode === "archive-repair") {
    throw new OracleArchiveRepairRequiredError("sensitive operation details must stay private");
  }
  if (mode === "ordinary") {
    throw new Error("ordinary child failure");
  }
  throw new Error("unknown CLI error fixture mode");
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = oracleCliExitCodeForError(error);
}
