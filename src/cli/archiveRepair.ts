export const ORACLE_ARCHIVE_REPAIR_REQUIRED_EXIT = 20;

export class OracleArchiveRepairRequiredError extends Error {
  readonly code = ORACLE_ARCHIVE_REPAIR_REQUIRED_EXIT;

  constructor(_message?: string, options?: { cause?: unknown }) {
    super("Archive cleanup could not be confirmed; repair is required.", options);
    this.name = "OracleArchiveRepairRequiredError";
  }
}
export function archiveRepairRequiredForCleanup(
  cleanupFailed: boolean,
  operationError?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): OracleArchiveRepairRequiredError | undefined {
  if (!cleanupFailed || env.ORACLE_ARCHIVE_REQUEST !== "1") return undefined;
  return new OracleArchiveRepairRequiredError(
    undefined,
    operationError ? { cause: operationError } : undefined,
  );
}

export function archiveRepairRequiredForOperation(
  operationFailed: boolean,
  operationError?: unknown,
  env: NodeJS.ProcessEnv = process.env,
): OracleArchiveRepairRequiredError | undefined {
  if (!operationFailed || env.ORACLE_ARCHIVE_REQUEST !== "1") return undefined;
  return new OracleArchiveRepairRequiredError(
    undefined,
    operationError ? { cause: operationError } : undefined,
  );
}
export function oracleCliExitCodeForError(error: unknown): number {
  return error instanceof OracleArchiveRepairRequiredError
    ? ORACLE_ARCHIVE_REPAIR_REQUIRED_EXIT
    : 1;
}
