import { describe, expect, test, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";

describe("profile directory authority", () => {
  test("rejects zero-birth storage before creating the profile", async () => {
    const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "oracle-profile-zero-birth-"));
    const profileDir = path.join(storageDir, "profile");
    const profilePaths = new Set([storageDir, await fs.realpath(storageDir)]);
    const actualFs = fs;
    const actualLstat = actualFs.lstat;
    const mockedLstat = async (...args: Parameters<typeof actualLstat>) => {
      const entry = await actualLstat(...args);
      return profilePaths.has(path.resolve(String(args[0])))
        ? new Proxy(entry, {
            get(target, property) {
              return property === "birthtimeNs" ? 0n : Reflect.get(target, property);
            },
          })
        : entry;
    };

    // Static imports capture the real built-in binding before this filesystem seam is installed.
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({ ...actualFs, lstat: mockedLstat }));
    try {
      const authority = await import("../../src/browser/profileDirectoryAuthority.js");
      await expect(
        authority.captureProfileDirectoryIdentity(profileDir, { create: true }),
      ).rejects.toThrow(/reports birthtimeNs=0.*stable nonzero birth time.*ORACLE_HOME_DIR/i);
      await expect(actualFs.readdir(storageDir)).resolves.toEqual([]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
      await actualFs.rm(storageDir, { recursive: true, force: true });
    }
  });
});
