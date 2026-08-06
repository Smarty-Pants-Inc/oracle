import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  encodeDirectoryRemovalMessage,
  parseDirectoryRemovalMessage,
} from "../../src/browser/filesystemLockDirectoryRemovalProtocol.js";
import type { DirectoryRemovalMessage } from "../../src/browser/filesystemLockDirectoryRemovalProtocol.js";
import {
  parsePhysicalDirectoryIdentity,
  samePhysicalDirectoryIdentity,
} from "../../src/browser/filesystemLockDirectoryIdentity.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const identity = { device: "1", inode: "2", birthtimeNs: "3" } as const;

describe("physical directory identity", () => {
  test("parses compatible serialized records and rejects malformed or changed identities", () => {
    const parsed = parsePhysicalDirectoryIdentity(JSON.parse(JSON.stringify(identity)));

    expect(parsed).toEqual(identity);
    expect(parsed).not.toBeNull();
    expect(samePhysicalDirectoryIdentity(parsed!, { ...identity, birthtimeNs: "4" })).toBe(false);
    expect(parsePhysicalDirectoryIdentity({ ...identity, device: "01" })).toBeNull();
    expect(parsePhysicalDirectoryIdentity({ device: "1", inode: "2" })).toBeNull();
    expect(parsePhysicalDirectoryIdentity({ ...identity, extra: true })).toBeNull();
  });
});

describe("filesystem lock directory removal protocol", () => {
  test.each<DirectoryRemovalMessage>([
    { type: "go", token: "go-token" },
    { type: "completed", token: "completed-token" },
    {
      type: "attested",
      token: "root-token",
      rootIdentity: identity,
      generationIdentity: identity,
    },
    {
      type: "attested-directory",
      token: "directory-token",
      directoryIdentity: identity,
      mountId: null,
    },
  ])("round trips the exact $type schema", (message) => {
    expect(parseDirectoryRemovalMessage(encodeDirectoryRemovalMessage(message))).toEqual(message);
  });

  test("rejects untyped fields and non-exact generation identities", () => {
    expect(() =>
      parseDirectoryRemovalMessage(
        JSON.stringify({ type: "completed", token: "token", unexpected: true }),
      ),
    ).toThrow(/invalid protocol message/i);
    expect(() =>
      parseDirectoryRemovalMessage(
        JSON.stringify({
          type: "attested",
          token: "token",
          rootIdentity: { ...identity, device: "01" },
          generationIdentity: identity,
        }),
      ),
    ).toThrow(/invalid root attestation/i);
  });
});

test("the standalone removal worker is compiled and included by the package globs", async () => {
  const coordinatorPath = path.join(
    repositoryRoot,
    "src/browser/filesystemLockDirectoryRemoval.ts",
  );
  const workerPath = path.join(
    repositoryRoot,
    "src/browser/filesystemLockDirectoryRemovalWorker.ts",
  );
  const buildConfigPath = path.join(repositoryRoot, "tsconfig.build.json");
  const packagePath = path.join(repositoryRoot, "package.json");

  const [coordinator, workerEntry, buildConfigRaw, packageRaw] = await Promise.all([
    readFile(coordinatorPath, "utf8"),
    stat(workerPath),
    readFile(buildConfigPath, "utf8"),
    readFile(packagePath, "utf8"),
  ]);
  const buildConfig = JSON.parse(buildConfigRaw) as { include?: string[] };
  const packageManifest = JSON.parse(packageRaw) as { files?: string[] };

  expect(coordinator).not.toContain("String.raw");
  expect(coordinator).toContain("filesystemLockDirectoryRemovalWorker");
  expect(workerEntry.isFile()).toBe(true);
  expect(buildConfig.include).toContain("src/**/*.ts");
  expect(packageManifest.files).toContain("dist/**/*");
});
