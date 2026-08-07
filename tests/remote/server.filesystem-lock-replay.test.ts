import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isolateDirectoryGenerationForRemoval } from "../../src/browser/filesystemLock.js";
import type { RemoteServerInstance } from "../../src/remote/server.js";
import { CAN_LISTEN_LOCALHOST, createTestRemoteServer } from "./serverTestBuilders.js";

describe("remote controller filesystem-lock replay", { timeout: 15_000 }, () => {
  test.skipIf(!CAN_LISTEN_LOCALHOST)(
    "preserves replacement state and leaves replay retryable when cleanup authority swaps",
    async () => {
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), "oracle-remote-lock-replay-race-"));
      const transactionStoreDir = path.join(tmpDir, "transactions");
      const displacedStoreDir = path.join(tmpDir, "transactions-displaced");
      const replacementStoreDir = path.join(tmpDir, "transactions-replacement");
      const controllerLockPath = path.join(transactionStoreDir, ".controller.lock");
      const oldCandidatePath = `${controllerLockPath}.released-old`;
      const options = { host: "127.0.0.1", port: 0, token: "a".repeat(64), logger: () => {} };
      let racedServer: RemoteServerInstance | undefined;
      let retriedServer: RemoteServerInstance | undefined;

      await mkdir(oldCandidatePath, { recursive: true });
      await writeFile(path.join(oldCandidatePath, "old-generation"), "preserve-old", "utf8");
      const oldIsolation = await isolateDirectoryGenerationForRemoval(
        oldCandidatePath,
        async () => true,
        controllerLockPath,
      );
      if (oldIsolation.status !== "isolated") throw new Error("Expected old isolated generation");
      const displacedWindowsGeneration = path.join(tmpDir, "generation-displaced");
      const replacementWindowsGeneration = path.join(tmpDir, "generation-replacement");

      let replacementIsolationRootName: string | undefined;
      let swapped = false;
      try {
        const racedStartup = createTestRemoteServer(options, {
          transactionStoreDir,
          controllerLockDeps: {
            afterPendingReleaseRemovalAttestation: async () => {
              if (swapped) return;
              swapped = true;
              if (process.platform === "win32") {
                const generationPath = path.join(oldIsolation.rootPath, "generation");
                await rename(generationPath, displacedWindowsGeneration);
                await mkdir(generationPath);
                await writeFile(
                  path.join(generationPath, "replacement-generation"),
                  "preserve-replacement",
                  "utf8",
                );
                return;
              }
              await rename(transactionStoreDir, displacedStoreDir);
              await mkdir(transactionStoreDir, { mode: 0o700 });
              const replacementCandidatePath = `${controllerLockPath}.released-replacement`;
              await mkdir(replacementCandidatePath);
              await writeFile(
                path.join(replacementCandidatePath, "replacement-generation"),
                "preserve-replacement",
                "utf8",
              );
              const replacementIsolation = await isolateDirectoryGenerationForRemoval(
                replacementCandidatePath,
                async () => true,
                controllerLockPath,
              );
              if (replacementIsolation.status !== "isolated") {
                throw new Error("Expected replacement isolated generation");
              }
              replacementIsolationRootName = path.basename(replacementIsolation.rootPath);
            },
          },
        }).then((server) => {
          racedServer = server;
          return server;
        });
        await expect(racedStartup).rejects.toThrow(
          process.platform === "win32"
            ? /Bound removal generation changed after attestation/i
            : "Filesystem lock parent generation changed",
        );

        expect(swapped).toBe(true);
        if (process.platform === "win32") {
          await expect(
            readFile(path.join(displacedWindowsGeneration, "old-generation"), "utf8"),
          ).resolves.toBe("preserve-old");
          await expect(
            readFile(
              path.join(oldIsolation.rootPath, "generation", "replacement-generation"),
              "utf8",
            ),
          ).resolves.toBe("preserve-replacement");
          await expect(
            readFile(`${oldIsolation.rootPath}.cleanup-journal.json`, "utf8"),
          ).resolves.toContain('"version":1');
        } else {
          if (!replacementIsolationRootName) {
            throw new Error("Replacement replay generation missing");
          }
          const oldPhysicalRoot = path.join(
            displacedStoreDir,
            path.basename(oldIsolation.rootPath),
          );
          const replacementPhysicalRoot = path.join(
            transactionStoreDir,
            replacementIsolationRootName,
          );
          await expect(
            readFile(path.join(oldPhysicalRoot, "generation", "old-generation"), "utf8"),
          ).resolves.toBe("preserve-old");
          await expect(
            readFile(
              path.join(replacementPhysicalRoot, "generation", "replacement-generation"),
              "utf8",
            ),
          ).resolves.toBe("preserve-replacement");
          await expect(
            readFile(`${oldPhysicalRoot}.cleanup-journal.json`, "utf8"),
          ).resolves.toContain('"version":1');
          await expect(
            readFile(`${replacementPhysicalRoot}.cleanup-journal.json`, "utf8"),
          ).resolves.toContain('"version":1');
        }

        if (process.platform === "win32") {
          await rename(
            path.join(oldIsolation.rootPath, "generation"),
            replacementWindowsGeneration,
          );
          await rename(displacedWindowsGeneration, path.join(oldIsolation.rootPath, "generation"));
        } else {
          await rename(transactionStoreDir, replacementStoreDir);
        }
        retriedServer = await createTestRemoteServer(options, { transactionStoreDir });
        await retriedServer.close();
        retriedServer = undefined;

        if (process.platform === "win32") {
          await expect(
            readFile(path.join(oldIsolation.rootPath, "generation", "old-generation"), "utf8"),
          ).rejects.toMatchObject({ code: "ENOENT" });
          await expect(
            readFile(path.join(replacementWindowsGeneration, "replacement-generation"), "utf8"),
          ).resolves.toBe("preserve-replacement");
        } else {
          if (!replacementIsolationRootName) {
            throw new Error("Replacement replay generation missing");
          }
          await expect(
            readFile(
              path.join(
                transactionStoreDir,
                path.basename(oldIsolation.rootPath),
                "generation",
                "old-generation",
              ),
              "utf8",
            ),
          ).rejects.toMatchObject({ code: "ENOENT" });
          await expect(
            readFile(
              path.join(
                replacementStoreDir,
                replacementIsolationRootName,
                "generation",
                "replacement-generation",
              ),
              "utf8",
            ),
          ).resolves.toBe("preserve-replacement");
        }
      } finally {
        await racedServer?.close().catch(() => undefined);
        await retriedServer?.close().catch(() => undefined);
        await rm(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
