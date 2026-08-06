import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { capturePhysicalDirectoryIdentity } from "../../src/browser/filesystemLockDirectoryIdentity.js";

describe("remote transaction integrity-key storage", () => {
  test.skipIf(process.platform === "win32")(
    "rejects a pathname replacement after the authenticated handle read",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-integrity-key-read-race-"));
      const directory = path.join(root, "integrity");
      const integrityKeyPath = path.join(directory, "record.key");
      const replacementPath = path.join(directory, "record.key.replacement");
      const originalKey = Buffer.alloc(32, 0x41);
      const replacementKey = Buffer.alloc(32, 0x42);
      let replaced = false;
      try {
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(integrityKeyPath, originalKey, { mode: 0o600 });
        await fs.writeFile(replacementPath, replacementKey, { mode: 0o600 });
        const directoryIdentity = await capturePhysicalDirectoryIdentity(directory);

        vi.resetModules();
        vi.doMock("node:fs/promises", () => ({
          ...fs,
          open: async (...args: Parameters<typeof fs.open>) => {
            const handle = await fs.open(...args);
            return new Proxy(handle, {
              get(target, property) {
                if (property === "readFile") {
                  return async (...readArgs: Parameters<typeof target.readFile>) => {
                    const bytes = await target.readFile(...readArgs);
                    await fs.rename(replacementPath, integrityKeyPath);
                    replaced = true;
                    return bytes;
                  };
                }
                const value = Reflect.get(target, property, target);
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          },
        }));
        // Reloading captures the per-test filesystem seam in the stable reader.
        const { readStableRemoteTransactionIntegrityKey } =
          await import("../../src/remote/transactionRecordStorage.js");
        let returnedKeyBytes: Buffer | undefined;

        await expect(
          readStableRemoteTransactionIntegrityKey(
            integrityKeyPath,
            directory,
            directoryIdentity,
            "win32",
          ).then((integrityKey) => {
            returnedKeyBytes = integrityKey.bytes;
          }),
        ).rejects.toThrow("Remote transaction integrity key is not a singly linked physical file");

        expect(replaced).toBe(true);
        expect(returnedKeyBytes).toBeUndefined();
        await expect(fs.readFile(integrityKeyPath)).resolves.toEqual(replacementKey);
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
