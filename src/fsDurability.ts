import { open } from "node:fs/promises";

export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function syncDirectoryIfPresent(directory: string): Promise<void> {
  try {
    await syncDirectory(directory);
  } catch (error) {
    if (readErrorCode(error) !== "ENOENT") throw error;
  }
}

export function readErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
