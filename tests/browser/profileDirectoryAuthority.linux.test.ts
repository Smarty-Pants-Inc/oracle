import { describe, expect, test } from "vitest";
import os from "node:os";
import path from "node:path";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest } from "../../src/browser/profileDirectoryAuthority.js";

const MARKER_FILENAME = ".oracle-profile-generation";

function linuxTest(name: string, run: () => Promise<void>): void {
  test.runIf(process.platform === "linux")(name, run);
}

describe("Linux zero-birthtime profile generation marker", () => {
  linuxTest("creates one owner-private marker and reuses its exact generation", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-linux-profile-marker-"));
    try {
      const first = await captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest(profileDir);
      const second = await captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest(profileDir);
      const markerPath = path.join(profileDir, MARKER_FILENAME);
      const markerStats = await stat(markerPath, { bigint: true });

      expect(first).toEqual(second);
      expect(first).toMatchObject({ version: 3, platform: "linux", birthtimeNs: "0" });
      expect(markerStats.mode & 0o777n).toBe(0o600n);
      expect(markerStats.nlink).toBe(1n);
      await expect(readFile(markerPath, "utf8")).resolves.toMatch(
        /^oracle-profile-generation-v1:[0-9a-f]{64}\n$/u,
      );
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  linuxTest(
    "keeps the final marker absent until publication and converges same-process creators",
    async () => {
      const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-linux-profile-race-"));
      const markerPrepared = Promise.withResolvers<void>();
      const finishPublication = Promise.withResolvers<void>();
      const concurrentWait = Promise.withResolvers<void>();
      const creator = captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest(profileDir, {
        beforeGenerationMarkerPublication: async () => {
          markerPrepared.resolve();
          await finishPublication.promise;
        },
      });
      let concurrent = creator;
      try {
        await markerPrepared.promise;
        await expect(lstat(path.join(profileDir, MARKER_FILENAME))).rejects.toMatchObject({
          code: "ENOENT",
        });

        concurrent = captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest(profileDir, {
          onGenerationMarkerCreationWait: concurrentWait.resolve,
        });
        await concurrentWait.promise;
        finishPublication.resolve();

        const [created, reused] = await Promise.all([creator, concurrent]);
        expect(reused).toEqual(created);
        await expect(readFile(path.join(profileDir, MARKER_FILENAME), "utf8")).resolves.toMatch(
          /^oracle-profile-generation-v1:[0-9a-f]{64}\n$/u,
        );
      } finally {
        finishPublication.resolve();
        await Promise.allSettled([creator, concurrent]);
        await rm(profileDir, { recursive: true, force: true });
      }
    },
  );

  linuxTest(
    "cleans interrupted preparation so a retry converges without stale marker bytes",
    async () => {
      const profileDir = await mkdtemp(
        path.join(os.tmpdir(), "oracle-linux-profile-interruption-"),
      );
      const markerPath = path.join(profileDir, MARKER_FILENAME);
      try {
        await expect(
          captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest(profileDir, {
            beforeGenerationMarkerPublication: () => {
              throw new Error("interrupted before publication");
            },
          }),
        ).rejects.toThrow(/no filesystem birth time/i);
        await expect(lstat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readdir(profileDir)).resolves.toEqual([]);

        const recovered =
          await captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest(profileDir);
        const markerStats = await stat(markerPath, { bigint: true });
        expect(markerStats.nlink).toBe(1n);
        expect(recovered.generationMarker?.token).toMatch(/^[0-9a-f]{64}$/u);
        await expect(readdir(profileDir)).resolves.toEqual([MARKER_FILENAME]);
      } finally {
        await rm(profileDir, { recursive: true, force: true });
      }
    },
  );

  linuxTest("fails closed without overwriting a malformed existing final marker", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-linux-profile-malformed-"));
    const markerPath = path.join(profileDir, MARKER_FILENAME);
    try {
      await writeFile(markerPath, "short\n", { mode: 0o600 });

      await expect(
        captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest(profileDir),
      ).rejects.toThrow(/generation marker/i);
      await expect(readFile(markerPath, "utf8")).resolves.toBe("short\n");
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  linuxTest("rejects a symlinked generation marker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-linux-profile-marker-symlink-"));
    const profileDir = path.join(root, "profile");
    const target = path.join(root, "forged-marker");
    try {
      await mkdir(profileDir);
      await writeFile(target, `oracle-profile-generation-v1:${"a".repeat(64)}\n`, {
        mode: 0o600,
      });
      await symlink(target, path.join(profileDir, MARKER_FILENAME));

      await expect(
        captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest(profileDir),
      ).rejects.toThrow(/generation marker/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  linuxTest("rejects insecure mode and forged marker content", async () => {
    const profileDir = await mkdtemp(path.join(os.tmpdir(), "oracle-linux-profile-marker-forge-"));
    const markerPath = path.join(profileDir, MARKER_FILENAME);
    try {
      await captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest(profileDir);
      await chmod(markerPath, 0o644);
      await expect(
        captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest(profileDir),
      ).rejects.toThrow(/generation marker/i);

      await chmod(markerPath, 0o600);
      const validContent = await readFile(markerPath, "utf8");
      await writeFile(markerPath, validContent.replace(/^oracle/u, "forged"), { mode: 0o600 });
      await expect(
        captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest(profileDir),
      ).rejects.toThrow(/generation marker/i);

      await writeFile(markerPath, "short\n", { mode: 0o600 });
      await expect(
        captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest(profileDir),
      ).rejects.toThrow(/generation marker/i);
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  linuxTest("rejects replacement of the authenticated profile directory generation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "oracle-linux-profile-generation-"));
    const profileDir = path.join(root, "profile");
    const movedDir = path.join(root, "moved-profile");
    try {
      await mkdir(profileDir);
      await expect(
        captureLinuxZeroBirthtimeProfileDirectoryIdentityForTest(profileDir, {
          beforeFinalEntry: async () => {
            await rename(profileDir, movedDir);
            await mkdir(profileDir);
          },
        }),
      ).rejects.toThrow(/directory generation changed/i);

      expect((await lstat(path.join(movedDir, MARKER_FILENAME))).isFile()).toBe(true);
      await expect(lstat(path.join(profileDir, MARKER_FILENAME))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
