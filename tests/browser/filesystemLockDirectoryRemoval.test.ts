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

  test("never authenticates a durable zero-birthtime replacement generation", () => {
    const zeroBirthtimeIdentity = { ...identity, birthtimeNs: "0" };
    const replacementWithReusedInode = { ...zeroBirthtimeIdentity };

    expect(parsePhysicalDirectoryIdentity(zeroBirthtimeIdentity)).toBeNull();
    expect(samePhysicalDirectoryIdentity(zeroBirthtimeIdentity, replacementWithReusedInode)).toBe(
      false,
    );
    expect(
      parsePhysicalDirectoryIdentity(zeroBirthtimeIdentity, { allowZeroBirthtime: true }),
    ).toEqual(zeroBirthtimeIdentity);
    expect(
      samePhysicalDirectoryIdentity(zeroBirthtimeIdentity, replacementWithReusedInode, {
        allowZeroBirthtime: true,
      }),
    ).toBe(true);
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
          rootIdentity: identity,
          generationIdentity: { ...identity, device: "01" },
        }),
      ),
    ).toThrow(/invalid root attestation/i);
  });
});
