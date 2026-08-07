import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { readUserConfigFile, writeUserConfigFile } from "../../src/bridge/userConfigFile.js";

const posixTest = process.platform === "win32" ? test.skip : test;

async function tempRoot(label: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), label));
}

describe("secure user config files", () => {
  posixTest("tightens an existing POSIX config to mode 0600 before reading", async () => {
    const root = await tempRoot("oracle-user-config-mode-");
    const configPath = path.join(root, "config.json");
    try {
      await fs.writeFile(configPath, '{ browser: { remoteHost: "127.0.0.1:9473" } }', {
        mode: 0o644,
      });

      await expect(readUserConfigFile(configPath)).resolves.toEqual({
        loaded: true,
        config: { browser: { remoteHost: "127.0.0.1:9473" } },
      });
      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  posixTest("rejects symbolic-link and hard-link config aliases", async () => {
    const root = await tempRoot("oracle-user-config-links-");
    const physicalPath = path.join(root, "physical.json");
    const symbolicPath = path.join(root, "symbolic.json");
    const hardLinkPath = path.join(root, "hard-link.json");
    try {
      await fs.writeFile(physicalPath, "{}", { mode: 0o600 });
      await fs.symlink(physicalPath, symbolicPath);
      await fs.link(physicalPath, hardLinkPath);

      await expect(readUserConfigFile(symbolicPath)).rejects.toThrow(
        /not a singly linked physical file/i,
      );
      await expect(readUserConfigFile(hardLinkPath)).rejects.toThrow(
        /not a singly linked physical file/i,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  posixTest("publishes a fresh POSIX config as one mode-0600 physical file", async () => {
    const root = await tempRoot("oracle-user-config-publish-");
    const configPath = path.join(root, "nested", "config.json");
    try {
      await writeUserConfigFile(configPath, { browser: { remoteHost: "127.0.0.1:9473" } });

      const entry = await fs.lstat(configPath);
      expect(entry.isFile()).toBe(true);
      expect(entry.isSymbolicLink()).toBe(false);
      expect(entry.nlink).toBe(1);
      expect(entry.mode & 0o777).toBe(0o600);
      await expect(readUserConfigFile(configPath)).resolves.toMatchObject({
        loaded: true,
        config: { browser: { remoteHost: "127.0.0.1:9473" } },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  posixTest(
    "restores the exact predecessor and removes scratch files when publication fails",
    async () => {
      const root = await tempRoot("oracle-user-config-rollback-");
      const configPath = path.join(root, "config.json");
      const predecessor = '{ browser: { remoteHost: "127.0.0.1:9000" } }\n';
      const publicationFailure = new Error("simulated config publication failure");
      await fs.writeFile(configPath, predecessor, { mode: 0o600 });
      const predecessorIdentity = await fs.lstat(configPath, { bigint: true });
      const actualFs = await vi.importActual<
        Record<string, unknown> & { default: typeof fs; link: typeof fs.link }
      >("node:fs/promises");
      let failedPublication = false;
      const link = vi.fn(async (existingPath: string, newPath: string) => {
        if (
          !failedPublication &&
          path.resolve(newPath) === path.resolve(configPath) &&
          path.basename(existingPath).startsWith(".oracle-config-")
        ) {
          failedPublication = true;
          throw publicationFailure;
        }
        await actualFs.link(existingPath, newPath);
      });
      vi.resetModules();
      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        default: { ...actualFs.default, link },
        link,
      }));
      try {
        // Intentional isolated reload: the deterministic rollback mutation replaces a built-in ESM binding.
        const { writeUserConfigFile: isolatedWriteUserConfigFile } =
          await import("../../src/bridge/userConfigFile.js");
        await expect(
          isolatedWriteUserConfigFile(configPath, {
            browser: { remoteHost: "127.0.0.1:9473" },
          }),
        ).rejects.toBe(publicationFailure);

        await expect(fs.readFile(configPath, "utf8")).resolves.toBe(predecessor);
        const restored = await fs.lstat(configPath, { bigint: true });
        expect({
          device: restored.dev,
          inode: restored.ino,
          birthtimeNs: restored.birthtimeNs,
          nlink: restored.nlink,
        }).toEqual({
          device: predecessorIdentity.dev,
          inode: predecessorIdentity.ino,
          birthtimeNs: predecessorIdentity.birthtimeNs,
          nlink: 1n,
        });
        await expect(fs.readdir(root)).resolves.toEqual(["config.json"]);
      } finally {
        vi.doUnmock("node:fs/promises");
        vi.resetModules();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  test("threads exact Windows create, protect, and verify authorities", async () => {
    const root = await tempRoot("oracle-user-config-windows-authority-");
    const configPath = path.join(root, "config.json");
    const create = vi.fn(async (request: { filePath: string; createNew?: boolean }) => {
      expect(request).toMatchObject({ createNew: true, repair: false });
      const handle = await fs.open(request.filePath, "wx", 0o600);
      await handle.close();
    });
    const protect = vi.fn(async () => undefined);
    const verify = vi.fn(async () => undefined);
    try {
      await writeUserConfigFile(
        configPath,
        { browser: { remoteHost: "127.0.0.1:9473" } },
        {
          platform: "win32",
          windowsPrivateFileAuthority: create,
          windowsPrivateFileProtectionAuthority: protect,
          windowsPrivateFileVerificationAuthority: verify,
        },
      );

      expect(create).toHaveBeenCalledOnce();
      expect(path.basename(create.mock.calls[0]![0].filePath)).toMatch(
        /^\.oracle-config-[a-f0-9]{32}\.tmp$/,
      );
      expect(protect).toHaveBeenCalledWith(configPath);
      expect(verify).toHaveBeenCalledWith(configPath);
      await expect(
        readUserConfigFile(configPath, {
          platform: "win32",
          windowsPrivateFileProtectionAuthority: protect,
          windowsPrivateFileVerificationAuthority: verify,
        }),
      ).resolves.toMatchObject({ loaded: true });
      expect(protect).toHaveBeenLastCalledWith(configPath);
      expect(verify).toHaveBeenLastCalledWith(configPath);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
